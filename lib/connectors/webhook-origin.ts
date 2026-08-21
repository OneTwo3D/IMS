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
 * every delivery, and the REST body repeats the same address in `_links.self[0].href` and in
 * a product's `permalink`. Recorded at receipt, that string still says "store A" no matter
 * how long the row sits in the inbox, how many times it is retried, or what the settings say
 * by the time it is processed.
 *
 * This module owns the ENCODING and the COMPARISON. Deriving the value from a particular
 * connector's delivery is the connector's job (WooCommerce: `readWcDeliveryOrigin`).
 *
 * NOT AN AUTHENTICATION CONTROL. A caller who already holds the webhook secret can put
 * anything in the body, so this adds no attack surface. Authenticity is the signature's job
 * (`verifyWcWebhook`); this is an integrity control against the operator's own rebind. It
 * does, however, care which evidence is INSIDE the signature — see `WebhookOriginScope`.
 */

/**
 * How much a stored statement proves about where the delivery came from.
 *
 * `exact` — the value IS the site root the store published for itself (`home_url('/')`, or a
 * REST link truncated at its `/wp-json/` boundary). Compared for equality.
 *
 * `under` — the value is some URL the store published that necessarily sits AT or UNDER its
 * site root (a product `permalink`). It cannot be compared for equality, because the resource
 * path is appended to the site root and is different on every delivery; it is compared for
 * containment instead.
 *
 * Keeping the two apart is what makes finding 2 answerable. Collapsing a `permalink` into
 * "the site root" is a guess — `https://example.com/store-b/product/widget` is either the
 * `/store-b` subsite's product `widget`, or the root site's product at a path that begins
 * `store-b`, and nothing in the URL says which. An `exact` statement never has that problem.
 */
export type WebhookOriginScope = 'exact' | 'under'

/** Prefix for a PROVEN site root: `store:<host>[/<path>]`. */
const STORE_PREFIX = 'store:'
/** Prefix for a PROVEN URL at-or-under the site root: `store-under:<host>[/<path>]`. */
const STORE_UNDER_PREFIX = 'store-under:'

/**
 * The four ways a row can positively record that it has no proven origin.
 *
 * They are distinct values on purpose, and that is the whole of finding 2 of round 2. A single
 * NULL meaning "written before this column existed" AND "written by current code, which found
 * nothing to record" is the o3d-t74p leniency: it reads as "fine" for rows that were never
 * examined at all. Every row now states which era wrote it and what that era found, so a
 * reader never has to guess — and the operator-facing log can say which of the four it was.
 */
export const WEBHOOK_ORIGIN_PRE_ATTESTATION = 'unproven:pre-attestation'
/** Current code, and the delivery made no statement about which store sent it. */
export const WEBHOOK_ORIGIN_NOT_STATED = 'unproven:not-stated'
/** Current code, and this connector's deliveries carry no store identity to record. */
export const WEBHOOK_ORIGIN_NOT_APPLICABLE = 'unproven:not-applicable'
/**
 * The column's DEFAULT: an INSERT that named no column at all.
 *
 * Only one writer can produce this — a build that predates the column, inserting during the
 * deploy window while the new schema is already live. Every current writer states a value.
 * See the migration for why the default exists at all rather than being dropped.
 */
export const WEBHOOK_ORIGIN_LEGACY_WRITER = 'unproven:legacy-writer'

/**
 * The comparable identity of a store URL: `<host>` for a root install, `<host>/<path>` for one
 * in a subdirectory. `null` for anything that is not an absolute http(s) URL.
 *
 * WHAT IS DROPPED, and why every one of these has to be:
 *
 *   - SCHEME and PORT. The two sides are not written by the same hand — the delivery states
 *     WordPress's `home_url()`, the bound value is whatever the operator typed into Settings —
 *     and `https` vs `http`, or an explicit `:443` against an implicit one, differ routinely
 *     on installs that work perfectly. A store reachable on two ports is one store.
 *   - A LEADING `www.`. An operator who typed `https://www.example.com` against a store whose
 *     `home_url()` is `https://example.com` has one store, not two, and WordPress's canonical
 *     redirect means the REST calls work. Two DIFFERENT stores distinguished only by `www.`
 *     is not a thing that exists.
 *   - TRAILING SLASHES and duplicated separators. `home_url('/')` always ends in `/`; the
 *     stored URL is normalised without one.
 *   - CASE, on the path as well as the host. Path case is significant to some web servers, but
 *     two distinct WordPress subsites on one host differing only in the case of their
 *     directory is not a real installation, and the cost of being wrong is asymmetric: a false
 *     "foreign store" ACKNOWLEDGES — permanently discards — a valid delivery.
 *
 * WHAT IS KEPT, and this is finding 2: the PATH. Round 2 compared the hostname alone, on the
 * reasoning that a subdirectory difference is a false positive. It is not. Path-based
 * WordPress multisite puts genuinely different stores on one host — `example.com/store-a` and
 * `example.com/store-b` — each with its own products, its own keys and its own webhooks, and
 * hostname-only identity attests the two identically. The subdirectory cannot differ between
 * the two sides while still being the same store either: `wc_url` is the base every REST call
 * is built on (`${url}/wp-json/wc/v3...`), so an operator whose store lives at `/store-b` has
 * `/store-b` in Settings or has no working connector at all.
 */
export function normaliseStoreIdentity(rawUrl: string | null | undefined): string | null {
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
  const bareHost = host.startsWith('www.') ? host.slice(4) : host
  return `${bareHost}${normalisePath(parsed.pathname)}`
}

function normalisePath(rawPath: string): string {
  const collapsed = rawPath.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return collapsed === '/' ? '' : collapsed
}

/**
 * Encode a SITE ROOT the delivery published for itself, ready to store.
 *
 * Returns `WEBHOOK_ORIGIN_NOT_STATED` — never a silent empty string — when the delivery said
 * nothing usable, so the stored value is always a positive statement.
 */
export function attestWebhookOrigin(rawUrl: string | null | undefined): string {
  const identity = normaliseStoreIdentity(rawUrl)
  return identity ? `${STORE_PREFIX}${identity}` : WEBHOOK_ORIGIN_NOT_STATED
}

/**
 * Encode a URL the delivery published that necessarily sits AT or UNDER its site root — a
 * product permalink, say — where the resource path cannot be separated from the site path.
 */
export function attestWebhookOriginUnder(rawUrl: string | null | undefined): string {
  const identity = normaliseStoreIdentity(rawUrl)
  return identity ? `${STORE_UNDER_PREFIX}${identity}` : WEBHOOK_ORIGIN_NOT_STATED
}

export type AttestedOrigin = { identity: string; scope: WebhookOriginScope }

/** What a stored attestation proves, or `null` for any `unproven:*` marker. */
export function attestedOrigin(attestation: string): AttestedOrigin | null {
  if (attestation.startsWith(STORE_PREFIX)) {
    const identity = attestation.slice(STORE_PREFIX.length)
    return identity ? { identity, scope: 'exact' } : null
  }
  if (attestation.startsWith(STORE_UNDER_PREFIX)) {
    const identity = attestation.slice(STORE_UNDER_PREFIX.length)
    return identity ? { identity, scope: 'under' } : null
  }
  return null
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
  /** `<host>[/<path>]` the delivery stated, or `null` when it stated nothing. */
  deliveryStore: string | null
  /** `<host>[/<path>]` this installation is bound to, or `null` when that is unreadable. */
  boundStore: string | null
  /** How the two were compared: equality (`exact`) or containment (`under`). */
  scope: WebhookOriginScope | null
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
  const delivery = attestedOrigin(attestation)
  const boundStore = normaliseStoreIdentity(boundStoreUrl)
  if (!delivery) {
    return { verdict: 'unproven', attestation, deliveryStore: null, boundStore, scope: null }
  }
  if (!boundStore) {
    return {
      verdict: 'binding-unreadable',
      attestation,
      deliveryStore: delivery.identity,
      boundStore: null,
      scope: delivery.scope,
    }
  }
  return {
    verdict: originMatches(delivery, boundStore) ? 'same-store' : 'foreign-store',
    attestation,
    deliveryStore: delivery.identity,
    boundStore,
    scope: delivery.scope,
  }
}

/**
 * `exact` compares for equality. `under` requires the delivery URL to sit at, or beneath, the
 * bound site root — and beneath means on a SEGMENT boundary, so `example.com/store-b` is not
 * read as being under `example.com/store` the way a bare `startsWith` would have it.
 *
 * A residual, stated rather than hidden: on a root-installed binding an `under` statement
 * proves only "somewhere on this host", because every subsite path is beneath the root path.
 * That is as much as a permalink can ever prove. It is why `under` is the LAST source
 * `readWcDeliveryOrigin` consults — `X-WC-Webhook-Source` and `_links.self` both yield `exact`
 * statements, and WooCommerce sends at least one of them on every delivery in practice.
 */
function originMatches(delivery: AttestedOrigin, boundStore: string): boolean {
  if (delivery.identity === boundStore) return true
  if (delivery.scope !== 'under') return false
  return delivery.identity.startsWith(`${boundStore}/`)
}
