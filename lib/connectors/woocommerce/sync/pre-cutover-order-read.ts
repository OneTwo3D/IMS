/**
 * FRESH, READ-ONLY VERIFICATION OF A PART DESPATCHED BEFORE THE STOREFRONT WENT LIVE.
 *
 * A split-order part despatched before the WooCommerce live-from instant is shadowed for good (the earlier writer owned the store
 * then), so the dispatch sweep never pushes it and, without this module, the IMS order never completes. The sweep asks here
 * instead, only for the shadow reason `obligation_before_cutoff`.
 *
 * WHY A LIVE READ AND NOT A STORED DELIVERY. A stored webhook delivery says what the store sent at some earlier moment; it cannot
 * say what the store holds NOW (a delayed `completed` after a newer reopen, a delivery from a store the order has since left).
 * Four evidence rules built on stored deliveries failed for that reason. This one asks the store, once, at verification time.
 *
 * THE READ. One `GET /orders/{id}` through the connector's own READ client (`wcFetch`: GET only, the connector's per-request
 * timeout, the ambient completion-attempt deadline). No retry loop of its own: the next sweep is the retry, and an order is read
 * at most once per sweep and never cached across sweeps. Reads are not blocked by the outbound-write hold (it classifies a GET as a
 * read) nor by the producer egress hold (that guards the write transport only), so this works while every write is held. This
 * module never calls a write function and never imports one; tests/wms-dispatch-pre-cutover-read.test.ts counts every request.
 *
 * VERIFIED ONLY WHEN ALL OF THESE HOLD (anything else, including every error, leaves the order pending: fail closed):
 *   - the order has a WooCommerce link, and the credentials resolve to a usable store;
 *   - the read succeeded and returned the order the link names (same id, and the same number when both state one);
 *   - the order's own `_links.self` names the store IMS is bound to NOW (a rebound or foreign store is refused);
 *   - the CURRENT status is `completed`;
 *   - `date_completed_gmt` (UTC; never the offset-less local `date_completed`) parses and is at or after the LATEST despatch among
 *     all the order's despatched parts.
 *
 * The outcome of every verification is written to the activity log without any customer data.
 */
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { judgeWebhookOrigin, attestWebhookOrigin } from '@/lib/connectors/webhook-origin'
import { getWcCredentials, wcFetch } from '../api'
import { normaliseWcOrderStatus } from '../order-status-filter'

export type PreCutoverReadCode =
  | 'verified'
  | 'no_despatch_time'
  | 'no_link'
  | 'not_configured'
  | 'read_failed'
  | 'unreadable_order'
  | 'wrong_order'
  | 'store_mismatch'
  | 'not_completed'
  | 'no_completion_date'
  | 'completed_before_despatch'

export type PreCutoverReadVerdict = { verified: boolean; code: PreCutoverReadCode; detail: string }

const REST_ROOT_MARKER = '/wp-json/'

/** `date_completed_gmt` as WooCommerce serialises it: ISO 8601 without a zone (it is GMT), or with an explicit `Z`. Anything else is unreadable. */
const GMT_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z?$/

/** Exported for test. Null for anything that is not an unambiguous UTC instant. */
export function parseWcGmtInstant(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!GMT_INSTANT.test(text)) return null
  const at = new Date(text.endsWith('Z') ? text : `${text}Z`)
  if (Number.isNaN(at.getTime())) return null
  // A calendar date that does not exist (31 February) rolls over silently: refuse it rather than read a different day.
  const [, year, month, day] = GMT_INSTANT.exec(text)!
  if (at.getUTCFullYear() !== Number(year) || at.getUTCMonth() + 1 !== Number(month) || at.getUTCDate() !== Number(day)) return null
  return at
}

/** The site root the order's own REST self-link names, as a comparable attestation; null when it names none. */
function orderStoreAttestation(order: Record<string, unknown>): string | null {
  const links = order._links
  if (typeof links !== 'object' || links === null) return null
  const self = (links as Record<string, unknown>).self
  if (!Array.isArray(self)) return null
  for (const entry of self) {
    if (typeof entry !== 'object' || entry === null) continue
    const href = (entry as Record<string, unknown>).href
    if (typeof href !== 'string') continue
    const markerAt = href.indexOf(REST_ROOT_MARKER)
    if (markerAt <= 0) continue
    const attestation = attestWebhookOrigin(href.slice(0, markerAt))
    if (!attestation.startsWith('unproven:')) return attestation
  }
  return null
}

async function decide(orderId: string, latestDespatchAt: Date | null): Promise<PreCutoverReadVerdict> {
  const no = (code: PreCutoverReadCode, detail: string): PreCutoverReadVerdict => ({ verified: false, code, detail })
  if (latestDespatchAt === null || Number.isNaN(latestDespatchAt.getTime())) {
    return no('no_despatch_time', 'no despatch time is known for the order\'s parts, so a completion cannot be shown to postdate them')
  }
  const link = await db.shoppingOrderLink.findFirst({
    where: { connector: 'woocommerce', orderId },
    select: { externalOrderId: true, externalOrderNumber: true },
  })
  if (!link?.externalOrderId) return no('no_link', 'the order has no WooCommerce link to read')

  let creds: Awaited<ReturnType<typeof getWcCredentials>>
  try {
    creds = await getWcCredentials()
  } catch {
    creds = null
  }
  if (!creds) return no('not_configured', 'the WooCommerce store is not configured')

  // The one request: a GET of the order from the store the credentials (and so the current binding) point at.
  let read: Awaited<ReturnType<typeof wcFetch>>
  try {
    read = await wcFetch(`/orders/${encodeURIComponent(link.externalOrderId)}`, {}, creds)
  } catch {
    return no('read_failed', 'the storefront order could not be read (request failed or timed out)')
  }
  if (read.error) return no('read_failed', 'the storefront order could not be read (the store refused or did not answer)')
  if (typeof read.data !== 'object' || read.data === null || Array.isArray(read.data)) {
    return no('unreadable_order', 'the storefront answered with something that is not an order')
  }
  const order = read.data as Record<string, unknown>

  if (String(order.id ?? '') !== link.externalOrderId) {
    return no('wrong_order', 'the storefront answered with a different order than the one linked')
  }
  if (link.externalOrderNumber && order.number !== undefined && String(order.number) !== link.externalOrderNumber) {
    return no('wrong_order', 'the storefront order number differs from the linked order number')
  }
  const attestation = orderStoreAttestation(order)
  if (attestation === null) return no('store_mismatch', 'the storefront order does not state which store it belongs to')
  if (judgeWebhookOrigin(attestation, creds.url).verdict !== 'same-store') {
    return no('store_mismatch', 'the storefront order belongs to a different store than the one the order is linked to now')
  }

  const status = normaliseWcOrderStatus(order.status)
  if (status !== 'completed') return no('not_completed', `the storefront order is "${status || 'unreadable'}" now, not completed`)

  const completedAt = parseWcGmtInstant(order.date_completed_gmt)
  if (completedAt === null) return no('no_completion_date', 'the storefront order has no readable completion time in GMT')
  if (completedAt.getTime() < latestDespatchAt.getTime()) {
    return no('completed_before_despatch', 'the storefront order was completed before the latest part was despatched')
  }
  return { verified: true, code: 'verified', detail: 'the storefront order is completed now, after the latest part was despatched' }
}

/** Verify, fail closed, and log the outcome. Never throws. */
export async function verifyPreCutoverCompletionByFreshRead(orderId: string, latestDespatchAt: Date | null): Promise<PreCutoverReadVerdict> {
  let verdict: PreCutoverReadVerdict
  try {
    verdict = await decide(orderId, latestDespatchAt)
  } catch {
    verdict = { verified: false, code: 'read_failed', detail: 'the verification could not be completed' }
  }
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: orderId,
    action: verdict.verified ? 'pre_cutover_part_verified' : 'pre_cutover_part_pending',
    tag: 'sync',
    level: 'INFO',
    description: verdict.verified
      ? 'A part despatched before the storefront went live was verified against a fresh read of the storefront order'
      : `A part despatched before the storefront went live could not be verified (${verdict.code}); the order stays pending`,
    metadata: { outcome: verdict.verified ? 'verified' : 'pending', code: verdict.code },
    resolveUser: false,
  }).catch(() => undefined)
  return verdict
}
