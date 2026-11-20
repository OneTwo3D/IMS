/**
 * INVENTORY OF THE CUSTOMER E-MAILS WOOCOMMERCE (AND ITS PLUGINS) SENDS, AND WHO SENDS EACH ONE AFTER STEP W. Static, typed, pure: no database, no network.
 *
 * Owner rulings of 2026-11-20 (customer e-mails from IMS):
 *   (a) ONE switch at step W (`storefront_customer_email_enabled`) covers every e-mail IMS sends for a storefront order. There are no per-email flags.
 *   (c) These stay in WooCommerce for good: the account e-mails (new account, password reset), the customer note and the on-hold, cancelled and failed status e-mails.
 *   (d) IMS sends the refund / credit-note e-mail, replacing `customer_refunded_order` at cutover.
 *
 * Every entry names the ownership row (`customer-email.<rowOperation>` in lib/security/writer-ownership-map.ts) that says who owns it in each phase.
 *
 * Plugin e-mail ids: WooCommerce's own e-mails have settings ids the store reports (`/wc/v3/settings/email_<id>`). The partial-shipment plugin, AST and TrackShip
 * are not WooCommerce settings and IMS cannot read them, so their entries use descriptive handles (prefix `plugin:`), not store ids. The owner switches them off
 * by hand at step W (no check sees them).
 *
 * NATIVE_EMAIL_EXCLUSIVE (lib/connectors/woocommerce/native-email-state.ts) still reads only `customer_processing_order` and `customer_completed_order`. It is
 * extended to `customer_refunded_order` in the slice that adds the IMS refund e-mail, not before: until IMS sends that e-mail, switching Woo's off would leave
 * nobody sending it.
 */

import {
  STOREFRONT_CONFIRMATION_KIND,
  STOREFRONT_DELIVERED_KIND,
  STOREFRONT_DISPATCHED_KIND,
  STOREFRONT_PARTIAL_KIND_PREFIX,
} from '@/lib/domain/storefront-customer-email/constants'
import { SALES_QUOTE_EMAIL_KIND } from '@/lib/domain/sales/sales-quote'

/** The kind `INVOICE` of the e-mail queue (the manual and queued customer invoice mail). */
export const INVOICE_EMAIL_KIND = 'INVOICE'

export type WooEmailSource = 'woocommerce-core' | 'plugin' | 'ims-only'

type EntryBase = {
  /** `customer-email.<rowOperation>` is this e-mail's row in the writer ownership map. */
  rowOperation: string
  /** The WooCommerce / plugin e-mails this entry covers (empty for an IMS-only e-mail). */
  wooEmailIds: readonly string[]
  source: WooEmailSource
}

export type WooEmailInventoryEntry =
  | (EntryBase & {
      disposition: 'replaced-by-ims'
      /** The e-mail queue kind IMS sends instead; with `kindIsPrefix` the kind is `<imsKind>:<id>`. */
      imsKind: string
      kindIsPrefix: boolean
    })
  | (EntryBase & {
      /** Owner ruling (d): IMS will send it; the kind is added in a later slice. */
      disposition: 'ims-planned'
      imsKind: null
    })
  | (EntryBase & {
      /** Owner ruling (c): WooCommerce keeps sending it in every phase. */
      disposition: 'stays-in-woo'
      reason: string
    })
  | (EntryBase & {
      /** An e-mail with no WooCommerce counterpart: IMS is the only sender. */
      disposition: 'ims-only'
      imsKind: string
      kindIsPrefix: false
    })

const RULING_C = 'Owner ruling 2026-11-20 (c): stays in WooCommerce for good.'

export const WOO_CUSTOMER_EMAIL_INVENTORY: readonly WooEmailInventoryEntry[] = [
  { rowOperation: 'order-confirmation', wooEmailIds: ['customer_processing_order'], source: 'woocommerce-core', disposition: 'replaced-by-ims', imsKind: STOREFRONT_CONFIRMATION_KIND, kindIsPrefix: false },
  { rowOperation: 'despatch', wooEmailIds: ['customer_completed_order'], source: 'woocommerce-core', disposition: 'replaced-by-ims', imsKind: STOREFRONT_DISPATCHED_KIND, kindIsPrefix: false },
  { rowOperation: 'invoice', wooEmailIds: ['customer_invoice'], source: 'woocommerce-core', disposition: 'replaced-by-ims', imsKind: INVOICE_EMAIL_KIND, kindIsPrefix: false },
  { rowOperation: 'partial-shipment', wooEmailIds: ['plugin:partial-shipment', 'plugin:ast-partial-shipped'], source: 'plugin', disposition: 'replaced-by-ims', imsKind: STOREFRONT_PARTIAL_KIND_PREFIX, kindIsPrefix: true },
  { rowOperation: 'delivered', wooEmailIds: ['plugin:ast-delivered', 'plugin:trackship-delivered'], source: 'plugin', disposition: 'replaced-by-ims', imsKind: STOREFRONT_DELIVERED_KIND, kindIsPrefix: false },
  { rowOperation: 'refund', wooEmailIds: ['customer_refunded_order'], source: 'woocommerce-core', disposition: 'ims-planned', imsKind: null },
  { rowOperation: 'quote', wooEmailIds: [], source: 'ims-only', disposition: 'ims-only', imsKind: SALES_QUOTE_EMAIL_KIND, kindIsPrefix: false },
  { rowOperation: 'account-new', wooEmailIds: ['customer_new_account'], source: 'woocommerce-core', disposition: 'stays-in-woo', reason: `${RULING_C} Account e-mail.` },
  { rowOperation: 'account-password-reset', wooEmailIds: ['customer_reset_password'], source: 'woocommerce-core', disposition: 'stays-in-woo', reason: `${RULING_C} Account e-mail.` },
  { rowOperation: 'customer-note', wooEmailIds: ['customer_note'], source: 'woocommerce-core', disposition: 'stays-in-woo', reason: `${RULING_C} Customer note.` },
  { rowOperation: 'status-on-hold', wooEmailIds: ['customer_on_hold_order'], source: 'woocommerce-core', disposition: 'stays-in-woo', reason: `${RULING_C} On-hold status e-mail.` },
  { rowOperation: 'status-cancelled', wooEmailIds: ['customer_cancelled_order'], source: 'woocommerce-core', disposition: 'stays-in-woo', reason: `${RULING_C} Cancelled status e-mail.` },
  { rowOperation: 'status-failed', wooEmailIds: ['customer_failed_order'], source: 'woocommerce-core', disposition: 'stays-in-woo', reason: `${RULING_C} Failed status e-mail.` },
]

/** Every WooCommerce core customer e-mail id the inventory covers. */
export const WOO_CORE_CUSTOMER_EMAIL_IDS: readonly string[] = WOO_CUSTOMER_EMAIL_INVENTORY.filter((entry) => entry.source === 'woocommerce-core').flatMap((entry) => entry.wooEmailIds)

/** The ownership-map key of an entry. */
export function inventoryOwnershipKey(entry: WooEmailInventoryEntry): string {
  return `customer-email.${entry.rowOperation}`
}

/** The inventory entry an IMS e-mail queue kind belongs to, or null when the kind is not a customer e-mail of the inventory. */
export function inventoryEntryForKind(kind: string): WooEmailInventoryEntry | null {
  for (const entry of WOO_CUSTOMER_EMAIL_INVENTORY) {
    if (entry.imsKind === null) continue
    if (entry.kindIsPrefix ? kind.startsWith(`${entry.imsKind}:`) : kind === entry.imsKind) return entry
  }
  return null
}

/** The inventory entry of a WooCommerce core e-mail id (or a plugin handle), or null. */
export function inventoryEntryForWooEmailId(id: string): WooEmailInventoryEntry | null {
  return WOO_CUSTOMER_EMAIL_INVENTORY.find((entry) => entry.wooEmailIds.includes(id)) ?? null
}
