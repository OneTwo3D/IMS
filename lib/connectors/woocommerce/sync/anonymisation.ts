/**
 * Recognising a WooCommerce order that WooCommerce has ANONYMISED, and the placeholder values it leaves behind.
 *
 * The signal is a POSITIVE marker, never an inference from blank or placeholder fields: WooCommerce's order
 * eraser (wc_anonymize_order) adds order meta `_anonymized` = 'yes', and the order then arrives as an ordinary
 * order.updated delivery / modified_after pull with its status unchanged (measured on the live shop's stage,
 * contract note 2026-11-06). Inferring erasure from "[deleted]" strings would destroy good data in one direction
 * and keep personal data in the other.
 *
 * The placeholders (`deleted@site.invalid`, "[deleted]") are the OTHER half of the same fact and are a hazard on
 * their own: an email lookup that treats `deleted@site.invalid` as an address merges every anonymised guest into
 * one customer. They are therefore never a match key and never stored, for ANY order, marked or not.
 */

import type { WcFullOrder } from './types'

/** WooCommerce core's own order-meta key (not store-configurable, so there is no setting for it). */
export const WC_ANONYMISED_META_KEY = '_anonymized'

/** True only for the exact positive marker. 'no', blank, missing or a non-string value is not a marker. */
export function isWcOrderAnonymised(order: Pick<WcFullOrder, 'meta_data'>): boolean {
  for (const meta of order.meta_data ?? []) {
    if (meta?.key === WC_ANONYMISED_META_KEY && typeof meta.value === 'string' && meta.value.trim().toLowerCase() === 'yes') return true
  }
  return false
}

/**
 * An email in the reserved `.invalid` TLD (RFC 2606) is a placeholder, never an address: WooCommerce writes
 * `deleted@site.invalid` and IMS writes `erased@erased.invalid`. Matched on the TLD, not on one literal.
 */
export function isPlaceholderEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '')
  return domain === 'invalid' || domain.endsWith('.invalid')
}

/** WooCommerce replaces names and address lines with the literal "[deleted]". */
export function isPlaceholderName(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === '[deleted]'
}

/**
 * Whether a payload still carries a real person's identity (a name, address line or email that is not a placeholder). Phone and
 * customer_note are deliberately not read: WooCommerce keeps customer_note on an anonymised order, so it would make every delivery look
 * like a re-population attempt.
 */
export function wcPayloadCarriesIdentity(order: Pick<WcFullOrder, 'billing' | 'shipping'>): boolean {
  const real = (value: unknown) => typeof value === 'string' && value.trim() !== '' && !isPlaceholderName(value)
  for (const part of [order.billing, order.shipping]) {
    if (!part) continue
    if (real(part.first_name) || real(part.last_name) || real(part.address_1) || real(part.postcode)) return true
    if (real(part.email) && !isPlaceholderEmail(part.email)) return true
  }
  return false
}
