import assert from 'node:assert/strict'
import test from 'node:test'

import { SHOPPING_CONNECTORS, parseShoppingConnectorId } from '@/lib/connectors/shopping-registry'

/**
 * o3d-remove-parked-connectors: this file used to name 'woocommerce' and 'shopify'. Shopify is
 * archived, so the "known connectors resolve to themselves" case is driven off the registry rather
 * than a second literal — a connector registered tomorrow is covered without an edit here, and the
 * case cannot silently shrink to nothing (the count is asserted).
 */
test('parseShoppingConnectorId: every registered connector resolves to itself', () => {
  assert.ok(SHOPPING_CONNECTORS.length >= 1, 'the registry must not be empty')
  let checked = 0
  for (const connector of SHOPPING_CONNECTORS) {
    assert.equal(parseShoppingConnectorId(connector.id), connector.id)
    checked += 1
  }
  assert.equal(checked, SHOPPING_CONNECTORS.length)
})

test('parseShoppingConnectorId: empty/absent value falls back to WooCommerce (back-compat)', () => {
  assert.equal(parseShoppingConnectorId(undefined), 'woocommerce')
  assert.equal(parseShoppingConnectorId(null), 'woocommerce')
  assert.equal(parseShoppingConnectorId(''), 'woocommerce')
})

// NO LONGER DISTINGUISHING, and said so rather than deleted (o3d-remove-parked-connectors). The
// explicit fallback used to be proved with 'shopify', the one registered id that was not the
// default. With one connector registered, the only legal argument IS the default, so this case
// cannot tell "the fallback was honoured" from "the default was used". It is kept as the shape a
// second connector restores meaning to; do not read it as coverage.
test('parseShoppingConnectorId: explicit fallback is accepted (cannot distinguish with one connector)', () => {
  assert.equal(parseShoppingConnectorId(undefined, 'woocommerce'), 'woocommerce')
})

test('parseShoppingConnectorId: unknown non-empty value returns null (caller rejects with 400)', () => {
  assert.equal(parseShoppingConnectorId('magento'), null)
  assert.equal(parseShoppingConnectorId('WooCommerce'), null) // case-sensitive
  assert.equal(parseShoppingConnectorId(42), null)
})
