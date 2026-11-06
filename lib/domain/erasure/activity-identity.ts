/**
 * REDACTING ACTIVITY ROWS BY STRUCTURE, NOT ONLY BY VALUE.
 *
 * A value-match pass only knows the subject's CURRENT values, so a name from before a rename survives it. The
 * structural pass does not depend on values at all:
 *
 *   - every activity row keyed to a CUSTOMER is identity-bearing (the customer actions write the name into the
 *     description, and a customer row has nothing else to say): its description becomes a fixed text. The action, the
 *     timestamps, the entity id, the level and the tag are kept.
 *   - for rows keyed to the customer's ORDERS, metadata keys that hold identity (by key name) are replaced; descriptions
 *     of order rows carry no identity today (see tests/erasure-activity-census.test.ts, which fails when a new action
 *     that writes identity is not classified) and are left to the value pass as a second net.
 *   - accounting markers carry connector, ids and amounts, no identity keys, and are left as they are.
 */

export const ERASED_ACTIVITY_DESCRIPTION = 'Record of a customer whose personal data was erased'
export const ERASED_ACTIVITY_VALUE = '[erased]'

/** Entity types whose every activity row is identity-bearing. */
export const IDENTITY_BEARING_ENTITY_TYPES: readonly string[] = ['CUSTOMER']

const IDENTITY_KEY =
  /^(first_?name|last_?name|full_?name|name|display_?name|customer_?name|contact_?name|company|email|customer_?email|contact_?email|phone|telephone|mobile|address\w*|line[12]|street|city|town|county|postcode|post_?code|zip|vat\w*|tax_?number|notes?|internal_?notes|customer_?note|tracking\w*|(billing|shipping)_?(address|name|first_?name|last_?name|company|email|phone))$/i

export function redactIdentityKeys(value: unknown, depth = 0): unknown {
  if (value == null || depth > 8) return value
  if (Array.isArray(value)) return value.map((v) => redactIdentityKeys(v, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, IDENTITY_KEY.test(k) ? ERASED_ACTIVITY_VALUE : redactIdentityKeys(v, depth + 1)]),
    )
  }
  return value
}
