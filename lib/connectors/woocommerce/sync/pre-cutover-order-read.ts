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
 *   - the store binding has NOT changed since the order's link was created (see {@link bindingChangedSince});
 *   - the CURRENT status is `completed`;
 *   - `date_completed_gmt` (UTC; never the offset-less local `date_completed`) parses and is at or after the LATEST despatch among
 *     all the order's despatched parts.
 *
 * "COMPLETED" IS NOT ENOUGH ON ITS OWN: an order completed after the despatch can still be edited (lines, quantities, refunds)
 * and stay `completed`. So, from the same single GET, the order must also be UNCHANGED since it was completed:
 *   - `date_modified_gmt` is no later than `date_completed_gmt` plus {@link MODIFIED_AFTER_COMPLETION_TOLERANCE_MS} (WooCommerce
 *     stamps a few follow-up writes of its own, such as a note or meta, within moments of the status change);
 *   - it has no refunds (`refunds` must be an array and empty);
 *   - its line items (id and quantity) are exactly the IMS order's goods lines.
 * Anything missing, unreadable or different is pending.
 *
 * STORE BINDING. An order link records no store identity, so after a rebind an old link could name the NEW store's order that
 * happens to have the same id and number. The binding's own record is the `wc_settings_version` setting, bumped by every rebind
 * or cache reset (a key rotation included: it is stricter than a store change, which is the safe direction). When that row was
 * last written AFTER the order or its link was created, the binding may have changed since, and the order stays pending.
 *
 * The outcome of every verification is written to the activity log without any customer data.
 */
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { judgeWebhookOrigin, attestWebhookOrigin } from '@/lib/connectors/webhook-origin'
import { getWcCredentials, wcFetch } from '../api'
import { normaliseWcOrderStatus } from '../order-status-filter'
import { WC_SETTINGS_VERSION_KEY } from '../sync-lock'
import { isMirroredFeeLine } from '@/lib/domain/wms/mirrored-fee-line'

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
  | 'binding_changed'
  | 'edited_after_completion'
  | 'refunded'
  | 'lines_differ'

export type PreCutoverReadVerdict = { verified: boolean; code: PreCutoverReadCode; detail: string }

/**
 * How much later than `date_completed_gmt` the order's `date_modified_gmt` may be before the order counts as edited since it was
 * completed. WooCommerce saves the order a moment after the status change (notes, meta); a minute covers that and no human edit.
 */
export const MODIFIED_AFTER_COMPLETION_TOLERANCE_MS = 60_000

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

/** Null when the storefront's line items are exactly the IMS order's goods lines (same WooCommerce line id, same quantity); otherwise why not. */
function compareLines(wooItems: unknown, imsLines: ReadonlyArray<{ sku: string | null; qty: unknown; wclcFeeKind: string | null; productId: string | null; externalLineItemId: number | null }>): string | null {
  if (!Array.isArray(wooItems)) return 'the storefront order has no readable line items'
  const woo = new Map<number, number>()
  for (const item of wooItems) {
    if (typeof item !== 'object' || item === null) return 'the storefront order has an unreadable line item'
    const { id, quantity } = item as { id?: unknown; quantity?: unknown }
    if (typeof id !== 'number' || !Number.isInteger(id) || typeof quantity !== 'number' || !Number.isFinite(quantity)) return 'the storefront order has an unreadable line item'
    woo.set(id, (woo.get(id) ?? 0) + quantity)
  }
  const ims = new Map<number, number>()
  for (const line of imsLines) {
    if (isMirroredFeeLine(line)) continue
    if (line.externalLineItemId === null || line.externalLineItemId === undefined) return 'an IMS goods line has no storefront line id to compare'
    const qty = Number(line.qty)
    if (!Number.isFinite(qty)) return 'an IMS line quantity is unreadable'
    ims.set(line.externalLineItemId, (ims.get(line.externalLineItemId) ?? 0) + qty)
  }
  if (woo.size !== ims.size) return 'the storefront order and the IMS order have different lines'
  for (const [id, qty] of ims) {
    if (woo.get(id) !== qty) return 'the storefront order and the IMS order have different lines or quantities'
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
    select: { externalOrderId: true, externalOrderNumber: true, createdAt: true },
  })
  if (!link?.externalOrderId) return no('no_link', 'the order has no WooCommerce link to read')

  // The store binding must not have changed since the order or its link came into being (the earlier of the two).
  const imsOrder = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { createdAt: true, lines: { select: { sku: true, qty: true, wclcFeeKind: true, productId: true, externalLineItemId: true } } },
  })
  if (!imsOrder) return no('no_link', 'the IMS order could not be found')
  const boundSince = await db.setting.findUnique({ where: { key: WC_SETTINGS_VERSION_KEY }, select: { updatedAt: true } })
  const origin = [link.createdAt, imsOrder.createdAt].filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))
  if (origin.length === 0) return no('binding_changed', 'when the order was linked is unknown, so the store binding cannot be shown unchanged')
  if (boundSince?.updatedAt) {
    const changedAt = boundSince.updatedAt instanceof Date ? boundSince.updatedAt.getTime() : Number.NaN
    if (Number.isNaN(changedAt)) return no('binding_changed', 'when the store binding last changed is unreadable')
    if (changedAt > Math.min(...origin.map((d) => d.getTime()))) {
      return no('binding_changed', 'the store binding changed after the order was linked, so the linked order id may now name a different store\'s order')
    }
  }

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

  // Unchanged since completion: not edited, not refunded, same lines.
  const modifiedAt = parseWcGmtInstant(order.date_modified_gmt)
  if (modifiedAt === null) return no('edited_after_completion', 'the storefront order has no readable modification time in GMT')
  if (modifiedAt.getTime() > completedAt.getTime() + MODIFIED_AFTER_COMPLETION_TOLERANCE_MS) {
    return no('edited_after_completion', 'the storefront order was modified after it was completed')
  }
  if (!Array.isArray(order.refunds)) return no('refunded', 'the storefront order does not say whether it has refunds')
  if (order.refunds.length > 0) return no('refunded', 'the storefront order has refunds')
  const lineVerdict = compareLines(order.line_items, imsOrder.lines)
  if (lineVerdict !== null) return no('lines_differ', lineVerdict)

  return { verified: true, code: 'verified', detail: 'the storefront order is completed now, after the latest part was despatched, and unchanged since' }
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
