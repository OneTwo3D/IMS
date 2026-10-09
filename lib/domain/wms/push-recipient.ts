import type { WmsOrderAddress } from '@/lib/connectors/wms/types'

/**
 * Who a warehouse order is addressed TO: the delivery recipient's name, company, address, phone and
 * email, resolved from the stored WooCommerce SHIPPING address (with the billing address as a
 * fallback), never from the customer account.
 *
 * This is a PURE function over the stored order JSON so the precedence rules can be tested as a table.
 * The rules follow the woo-mintsoft plugin (`_build_payload` in wc_mintsoft_orders.py), with the two
 * deliberate differences listed after them.
 *
 *  1. The delivery address is the shipping address if it names a recipient (a first name or a street
 *     line). A shipping address with neither (blank, or company-only) is NOT a usable destination, so
 *     the whole billing address is used instead — name, company and street all come from ONE address;
 *     the two are never mixed field-by-field.
 *  2. Every text value is trimmed; a blank value counts as absent.
 *  3. Phone numbers and emails are passed through verbatim apart from trimming: international formats
 *     ("+44 7700 900123", "00353 1 234 5678", "(555) 010-9999 ext 4") are never rewritten, because the
 *     carrier needs what the customer typed.
 *
 * DIFFERENCES FROM THE PLUGIN (owner decision 2026-09-28: a gift order ships to the recipient):
 *  - Phone and email prefer the delivery address's own value and fall back to the billing one. The
 *    plugin always sends the billing phone and email. WooCommerce core has no shipping email field, so
 *    the email fallback is the common case; a shipping phone is a core field from WooCommerce 5.6.
 *  - When the delivery address carries no name at all, the order's customer name is split into first and
 *    last name (the behaviour before recipient fields were stored; also what rows imported earlier still
 *    rely on). The plugin would send an empty name.
 *
 * LEGACY ROWS: an address imported before these fields were stored has only `line1` (street + company
 * joined) and no `address1`. Such a row is read as it always was; it cannot be split back into street and
 * company, so its company stays inside the street line.
 */

type AddressRecord = Record<string, unknown>

function asRecord(raw: unknown): AddressRecord {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AddressRecord) : {}
}

function text(record: AddressRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** True for an address stored with the separate-parts shape (see mapWcAddress). */
function isPartsShape(record: AddressRecord): boolean {
  return typeof record.address1 === 'string'
}

/** The street line to send: the plain street when stored, else the legacy composite. */
function streetLine(record: AddressRecord): string {
  return isPartsShape(record) ? text(record, 'address1') : text(record, 'address1', 'line1', 'address_1')
}

/** Does this address name someone or somewhere to deliver to? (A company alone does not.) */
function namesARecipient(record: AddressRecord): boolean {
  return text(record, 'firstName') !== '' || streetLine(record) !== ''
}

function addressFrom(record: AddressRecord, fallbackName: string | null): WmsOrderAddress {
  let firstName = text(record, 'firstName')
  let lastName = text(record, 'lastName')
  if (!firstName && !lastName) {
    const [first, ...rest] = (fallbackName ?? '').trim().split(/\s+/).filter(Boolean)
    firstName = first ?? ''
    lastName = rest.join(' ')
  }
  return {
    firstName,
    lastName,
    company: text(record, 'company'),
    address1: streetLine(record),
    address2: text(record, 'line2', 'address2', 'address_2'),
    town: text(record, 'city', 'town'),
    county: text(record, 'county', 'state'),
    postCode: text(record, 'postcode', 'postCode', 'postal_code'),
    country: text(record, 'country'),
  }
}

export type PushRecipient = {
  address: WmsOrderAddress
  phone: string | null
  email: string | null
  /** Which stored address supplied the name and street: the order's shipping or billing address. */
  addressSource: 'shipping' | 'billing'
}

export function resolvePushRecipient(order: {
  shippingAddress: unknown
  billingAddress?: unknown
  customerName: string | null
  customerEmail: string | null
}): PushRecipient {
  const shipping = asRecord(order.shippingAddress)
  const billing = asRecord(order.billingAddress)
  const useBilling = !namesARecipient(shipping) && namesARecipient(billing)
  const delivery = useBilling ? billing : shipping
  return {
    address: addressFrom(delivery, order.customerName),
    phone: text(delivery, 'phone') || text(billing, 'phone') || null,
    email: text(delivery, 'email') || text(billing, 'email') || order.customerEmail?.trim() || null,
    addressSource: useBilling ? 'billing' : 'shipping',
  }
}
