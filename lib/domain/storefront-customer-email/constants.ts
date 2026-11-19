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
/**
 * THE SWITCH-ON INSTANT. Written (ISO UTC) in the same write that turns the switch ON (the settings writer and `settings:set`), never writable on its own.
 * Every history guard below is anchored to it: IMS e-mails only what happened AFTER it, because everything before it was e-mailed by WooCommerce (or was
 * not e-mailed by anyone and is not re-announced). Missing or unreadable with the switch on = nothing is sent (fail closed).
 */
export const STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY = 'storefront_customer_email_enabled_at'

/** The stored switch-on instant as a Date, or null when absent or unreadable. */
export function parseStorefrontEmailEnabledAt(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value.trim())
  return Number.isFinite(ms) ? new Date(ms) : null
}

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
 * HISTORY IS NOT RE-ANNOUNCED, by TWO bounds that must both hold. (1) AGE: an order imported long after it was placed (a back-fill) gets no confirmation, and
 * an order marked delivered or a shipment despatched long ago (an operator bulk-advancing old orders) gets no delivered / partial / dispatched e-mail.
 * (2) THE SWITCH-ON INSTANT (`storefront_customer_email_enabled_at`): an order PLACED before it gets no confirmation, by any path, the release of a held order
 * included (WooCommerce sent it, or owed it and no longer sends it), and a dispatched / partial / delivered e-mail goes out only for a shipment DISPATCHED
 * after it. There is NO exception: a bank-transfer order placed before the switch-on and paid after it is confirmed by nobody in IMS. Those orders are
 * covered by a person, from the read-only list `npm run storefront:hand-send` (runbook step W). The release of an order placed after the switch-on is judged
 * on the release (the paid time), because WooCommerce's native confirmation fires on that move and is off by then.
 */
export const STOREFRONT_CONFIRMATION_MAX_AGE_MS = 48 * 60 * 60 * 1000
export const STOREFRONT_SHIPMENT_EMAIL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
/** The age bound of the storefront "dispatched" e-mail (the order's despatch time), the same as the other shipment e-mails. */
export const STOREFRONT_DISPATCHED_MAX_AGE_MS = STOREFRONT_SHIPMENT_EMAIL_MAX_AGE_MS

export type StorefrontEmailKindName = 'confirmation' | 'partial' | 'delivered'
export type StorefrontEmailEligibilityInput = {
  kind: StorefrontEmailKindName
  settingValue: string | null
  /** `storefront_customer_email_enabled_at`: when the switch was turned on. Null = unknown: nothing is eligible. */
  enabledAt: Date | null
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
    /** Confirmation only: set when the order moved to processing from a held status (PENDING_PAYMENT / ON_HOLD). The age and switch-on anchor then. */
    releasedAt?: Date | null
  } | null
  /** The shipment, for the partial kind. */
  shipment?: { status: string; shippedAt: Date | null; orderId: string } | null
  orderId: string
  alreadyQueued: boolean
}
export type StorefrontEmailEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'disabled' | 'order_not_found' | 'not_storefront_order' | 'quote' | 'no_customer_email' | 'wrong_status' | 'too_old' | 'before_switch_on' | 'switch_time_unknown' | 'shipment_not_shipped' | 'already_queued' }

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
  if (input.enabledAt === null || Number.isNaN(input.enabledAt.getTime())) return { eligible: false, reason: 'switch_time_unknown' }
  const enabledMs = input.enabledAt.getTime()
  if (input.kind === 'confirmation') {
    if (NOT_YET_ORDER_STATUSES.has(order.status)) return { eligible: false, reason: 'wrong_status' }
    // An order PLACED before the switch-on was confirmed by WooCommerce (or refused as history): never through any path, release included.
    if (order.placedAt === null) return { eligible: false, reason: 'too_old' }
    if (order.placedAt.getTime() < enabledMs) return { eligible: false, reason: 'before_switch_on' }
    // A released held order is judged on its release (the storefront's paid time); any other order on its placement.
    const anchor = order.releasedAt ?? order.placedAt
    if (anchor.getTime() < enabledMs) return { eligible: false, reason: 'before_switch_on' }
    if (input.now.getTime() - anchor.getTime() > STOREFRONT_CONFIRMATION_MAX_AGE_MS) return { eligible: false, reason: 'too_old' }
  } else if (input.kind === 'delivered') {
    if (order.status !== 'DELIVERED') return { eligible: false, reason: 'wrong_status' }
    // Age is judged by the despatch; an order with no despatch time recorded stands on its placement time.
    const anchor = order.shippedAt ?? order.placedAt
    if (anchor === null) return { eligible: false, reason: 'too_old' }
    if (anchor.getTime() < enabledMs) return { eligible: false, reason: 'before_switch_on' }
    if (input.now.getTime() - anchor.getTime() > STOREFRONT_SHIPMENT_EMAIL_MAX_AGE_MS) return { eligible: false, reason: 'too_old' }
  } else {
    // partial shipment: the order is still waiting for more (not SHIPPED or later), the shipment itself has shipped, recently.
    if (!AWAITING_DESPATCH_STATUSES.has(order.status)) return { eligible: false, reason: 'wrong_status' }
    const shipment = input.shipment
    if (!shipment || shipment.orderId !== input.orderId || shipment.status !== 'SHIPPED') return { eligible: false, reason: 'shipment_not_shipped' }
    if (shipment.shippedAt === null) return { eligible: false, reason: 'too_old' }
    if (shipment.shippedAt.getTime() < enabledMs) return { eligible: false, reason: 'before_switch_on' }
    if (input.now.getTime() - shipment.shippedAt.getTime() > STOREFRONT_SHIPMENT_EMAIL_MAX_AGE_MS) return { eligible: false, reason: 'too_old' }
  }
  if (input.alreadyQueued) return { eligible: false, reason: 'already_queued' }
  return { eligible: true }
}
