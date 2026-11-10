import assert from 'node:assert/strict'
import test from 'node:test'

import { getInventoryChildren } from '../../../lib/sidebar/inventory-children.ts'

test('inventory group without inventory.edit shows Products only', () => {
  assert.deepEqual(getInventoryChildren(false), [{ href: '/inventory', label: 'Products' }])
})

test('inventory group with inventory.edit adds HS Code Review after Products', () => {
  assert.deepEqual(getInventoryChildren(true), [
    { href: '/inventory', label: 'Products' },
    { href: '/trade/hs-code-review', label: 'HS Code Review' },
  ])
})
