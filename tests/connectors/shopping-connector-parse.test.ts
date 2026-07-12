import assert from 'node:assert/strict'
import test from 'node:test'

import { parseShoppingConnectorId } from '@/lib/connectors/shopping-registry'

test('parseShoppingConnectorId: known connectors resolve to themselves', () => {
  assert.equal(parseShoppingConnectorId('woocommerce'), 'woocommerce')
  assert.equal(parseShoppingConnectorId('shopify'), 'shopify')
})

test('parseShoppingConnectorId: empty/absent value falls back to WooCommerce (back-compat)', () => {
  assert.equal(parseShoppingConnectorId(undefined), 'woocommerce')
  assert.equal(parseShoppingConnectorId(null), 'woocommerce')
  assert.equal(parseShoppingConnectorId(''), 'woocommerce')
})

test('parseShoppingConnectorId: explicit fallback is honoured', () => {
  assert.equal(parseShoppingConnectorId(undefined, 'shopify'), 'shopify')
})

test('parseShoppingConnectorId: unknown non-empty value returns null (caller rejects with 400)', () => {
  assert.equal(parseShoppingConnectorId('magento'), null)
  assert.equal(parseShoppingConnectorId('WooCommerce'), null) // case-sensitive
  assert.equal(parseShoppingConnectorId(42), null)
})
