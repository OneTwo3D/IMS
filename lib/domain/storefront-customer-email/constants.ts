/**
 * CUSTOMER E-MAIL FOR STOREFRONT ORDERS, SENT BY IMS (switchover step W). Constants and the pure decisions. No database, no clock of its own.
 *
 * Until step W, WooCommerce (with the partial-shipment plugin, AST and TrackShip) sends every customer e-mail for a storefront order and IMS sends none
 * (`dispatch-email` refuses a storefront-linked order). At step W the owner switches WooCommerce's native e-mails OFF first and then this switch ON, so a
 * missed e-mail (which can be re-sent) is the risk and a duplicate (which cannot be unsent) is not. The two must never both be on: `writers:check` in phase
 * P2-W reads the store's native e-mail settings against this switch (evidence NATIVE_EMAIL_EXCLUSIVE) and fails when both or neither send.
 *
 * ONE SWITCH, `storefront_customer_email_enabled`, DEFAULT OFF, for the four e-mails of a storefront order:
 *   order confirmation   queued when IMS imports the order               kind STOREFRONT_ORDER_CONFIRMATION     once per order
 *   dispatched           queued when the order reaches SHIPPED           kind SHIPMENT_DISPATCHED               once per order (the kind direct orders use)
 *   partial shipment     queued when ONE shipment of several despatches  kind STOREFRONT_PARTIAL_SHIPMENT:<id>   once per shipment
 *   delivered            queued when the order is marked DELIVERED       kind STOREFRONT_ORDER_DELIVERED        once per order
 *
 * SINGLE SEND. Every kind is queued at most once per (kind, order): the existence check looks at ANY status of that kind and runs under the order row
 * lock, and the outbox's partial unique index backs it in the database. A row that ended FAILED (including an unknown outcome) is NOT queued again by
 * the automatic path: a person re-sends it. The partial-shipment kind carries the shipment id IN THE KIND so one order can have several (one per
 * shipment), while the reference stays `SalesOrder`/<order id>, which is what the erasure and the recipient checks key on.
 *
 * The switch is read when the e-mail is queued AND again when it is built (send time), so a row queued before the switch was turned off ends FAILED with
 * the reason and nothing is sent. The send itself is a single send: a send that may have been accepted but whose outcome is unknown ends terminally
 * FAILED, is never retried, and is recorded as a WARNING on the order.
 */

export const STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY = 'storefront_customer_email_enabled'
export const STOREFRONT_CUSTOMER_EMAIL_DISABLED_REASON = 'Not sent: customer e-mail for storefront orders is switched off in IMS (Settings > Sales)'

export const STOREFRONT_CONFIRMATION_KIND = 'STOREFRONT_ORDER_CONFIRMATION'
export const STOREFRONT_DELIVERED_KIND = 'STOREFRONT_ORDER_DELIVERED'
export const STOREFRONT_PARTIAL_KIND_PREFIX = 'STOREFRONT_PARTIAL_SHIPMENT'
/** The kind direct orders already use; for a storefront order it is the "dispatched" e-mail. */
export const STOREFRONT_DISPATCHED_KIND = 'SHIPMENT_DISPATCHED'

export function storefrontPartialKind(shipmentId: string): string {
  return `${STOREFRONT_PARTIAL_KIND_PREFIX}:${shipmentId}`
}

/** The shipment id inside a partial-shipment kind, or null when the kind is not one. */
export function shipmentIdOfPartialKind(kind: string): string | null {
  if (!kind.startsWith(`${STOREFRONT_PARTIAL_KIND_PREFIX}:`)) return null
  const id = kind.slice(STOREFRONT_PARTIAL_KIND_PREFIX.length + 1)
  return id.length > 0 ? id : null
}

/** Kinds whose recipient is a storefront customer and whose single-send outcome is recorded on the order. */
export function isStorefrontCustomerEmailKind(kind: string): boolean {
  return kind === STOREFRONT_CONFIRMATION_KIND || kind === STOREFRONT_DELIVERED_KIND || shipmentIdOfPartialKind(kind) !== null
}

/**
 * HISTORY IS NOT RE-ANNOUNCED. An order imported long after it was placed (a back-fill) gets no confirmation, and an order marked delivered or a shipment
 * despatched long ago (an operator bulk-advancing old orders) gets no delivered / partial e-mail. The "dispatched" e-mail is bounded by the exact SHIPPED
 * status instead (as it is for direct orders).
 */
export const STOREFRONT_CONFIRMATION_MAX_AGE_MS = 48 * 60 * 60 * 1000
export const STOREFRONT_SHIPMENT_EMAIL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export type StorefrontEmailKindName = 'confirmation' | 'partial' | 'delivered'
export type StorefrontEmailEligibilityInput = {
  kind: StorefrontEmailKindName
  settingValue: string | null
  now: Date
  order: {
    status: string
    isQuote: boolean
    customerEmail: string | null
    shoppingLinkCount: number
    /** When the order was placed (the storefront's creation time, else IMS's). */
    placedAt: Date | null
    /** When the order's goods left (the order's own `shippedAt`). */
    shippedAt?: Date | null
  } | null
  /** The shipment, for the partial kind. */
  shipment?: { status: string; shippedAt: Date | null; orderId: string } | null
  orderId: string
  alreadyQueued: boolean
}
export type StorefrontEmailEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'disabled' | 'order_not_found' | 'not_storefront_order' | 'quote' | 'no_customer_email' | 'wrong_status' | 'too_old' | 'shipment_not_shipped' | 'already_queued' }

const NOT_YET_ORDER_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'PENDING_PAYMENT', 'ON_HOLD', 'CANCELLED'])
const AWAITING_DESPATCH_STATUSES: ReadonlySet<string> = new Set(['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'])

/** Pure decision: should this storefront e-mail be queued now? */
export function evaluateStorefrontEmailEligibility(input: StorefrontEmailEligibilityInput): StorefrontEmailEligibility {
  if (input.settingValue !== 'true') return { eligible: false, reason: 'disabled' }
  if (!input.order) return { eligible: false, reason: 'order_not_found' }
  const { order } = input
  if (order.shoppingLinkCount <= 0) return { eligible: false, reason: 'not_storefront_order' }
  if (order.isQuote) return { eligible: false, reason: 'quote' }
  if (!order.customerEmail || order.customerEmail.trim() === '') return { eligible: false, reason: 'no_customer_email' }
  if (input.kind === 'confirmation') {
    if (NOT_YET_ORDER_STATUSES.has(order.status)) return { eligible: false, reason: 'wrong_status' }
    if (order.placedAt === null || input.now.getTime() - order.placedAt.getTime() > STOREFRONT_CONFIRMATION_MAX_AGE_MS) return { eligible: false, reason: 'too_old' }
  } else if (input.kind === 'delivered') {
    if (order.status !== 'DELIVERED') return { eligible: false, reason: 'wrong_status' }
    // Age is judged by the despatch; an order with no despatch time recorded stands on its placement time.
    const anchor = order.shippedAt ?? order.placedAt
    if (anchor === null || input.now.getTime() - anchor.getTime() > STOREFRONT_SHIPMENT_EMAIL_MAX_AGE_MS) return { eligible: false, reason: 'too_old' }
  } else {
    // partial shipment: the order is still waiting for more (not SHIPPED or later), the shipment itself has shipped, recently.
    if (!AWAITING_DESPATCH_STATUSES.has(order.status)) return { eligible: false, reason: 'wrong_status' }
    const shipment = input.shipment
    if (!shipment || shipment.orderId !== input.orderId || shipment.status !== 'SHIPPED') return { eligible: false, reason: 'shipment_not_shipped' }
    if (shipment.shippedAt === null || input.now.getTime() - shipment.shippedAt.getTime() > STOREFRONT_SHIPMENT_EMAIL_MAX_AGE_MS) return { eligible: false, reason: 'too_old' }
  }
  if (input.alreadyQueued) return { eligible: false, reason: 'already_queued' }
  return { eligible: true }
}
