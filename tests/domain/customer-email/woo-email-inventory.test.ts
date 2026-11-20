import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  WOO_CORE_CUSTOMER_EMAIL_IDS,
  WOO_CUSTOMER_EMAIL_INVENTORY,
  inventoryEntryForKind,
  inventoryOwnershipKey,
} from '@/lib/domain/customer-email/woo-email-inventory'
import {
  STOREFRONT_CONFIRMATION_KIND,
  STOREFRONT_DELIVERED_KIND,
  STOREFRONT_DISPATCHED_KIND,
  isStorefrontCustomerEmailKind,
  storefrontPartialKind,
} from '@/lib/domain/storefront-customer-email/constants'
import { WOO_NATIVE_CUSTOMER_EMAIL_IDS } from '@/lib/connectors/woocommerce/native-email-state'
import { ownershipRowFor } from '@/lib/security/writer-ownership-map'

// The kinds the e-mail builder really prepares, read from its source (buildEmail in lib/order-email.ts), so a new kind cannot be missed.
const BUILDER_SOURCE = readFileSync(new URL('../../../lib/order-email.ts', import.meta.url), 'utf8')
const CONSTANT_KINDS: Record<string, string> = { STOREFRONT_CONFIRMATION_KIND, STOREFRONT_DELIVERED_KIND }
const BUILDER_KINDS = [
  ...[...BUILDER_SOURCE.matchAll(/\bkind === '([A-Z_]+)'/g)].map((match) => match[1]!),
  ...[...BUILDER_SOURCE.matchAll(/\bkind === ([A-Z_]+_KIND)\b/g)].map((match) => CONSTANT_KINDS[match[1]!] ?? assert.fail(`unresolved kind constant ${match[1]}`)),
]
const KINDS = [...BUILDER_KINDS, storefrontPartialKind('ship_1'), storefrontPartialKind('ship_2')]

test('the builder source was read: it prepares the known kinds', () => {
  for (const kind of ['SALES_ORDER_CONFIRMATION', 'INVOICE', 'ACCOUNTING_INVOICE', 'SHIPMENT_DISPATCHED', STOREFRONT_CONFIRMATION_KIND, STOREFRONT_DELIVERED_KIND, 'SALES_QUOTE']) assert.ok(BUILDER_KINDS.includes(kind), kind)
})

test('every IMS customer e-mail kind maps to exactly one inventory entry', () => {
  for (const kind of KINDS) {
    const matches = WOO_CUSTOMER_EMAIL_INVENTORY.filter((entry) => 'imsKinds' in entry && entry.imsKinds.some((imsKind) => ('kindIsPrefix' in entry && entry.kindIsPrefix ? kind.startsWith(`${imsKind}:`) : kind === imsKind)))
    assert.equal(matches.length, 1, kind)
    assert.equal(inventoryEntryForKind(kind), matches[0], kind)
  }
  for (const kind of KINDS.filter(isStorefrontCustomerEmailKind)) assert.equal(inventoryEntryForKind(kind)?.disposition, 'replaced-by-ims', kind)
  assert.equal(inventoryEntryForKind('SOMETHING_ELSE'), null)
})

test('every entry has an existing ownership row, and none is duplicated', () => {
  const rows = WOO_CUSTOMER_EMAIL_INVENTORY.map(inventoryOwnershipKey)
  assert.equal(new Set(rows).size, rows.length, 'one entry per row')
  for (const entry of WOO_CUSTOMER_EMAIL_INVENTORY) assert.ok(ownershipRowFor('customer-email', entry.rowOperation), entry.rowOperation)
  const ids = WOO_CUSTOMER_EMAIL_INVENTORY.flatMap((entry) => entry.wooEmailIds)
  assert.equal(new Set(ids).size, ids.length, 'no e-mail id in two entries')
})

test('every WooCommerce core customer e-mail is covered, and the ids IMS already reads are among them', () => {
  assert.deepEqual([...WOO_CORE_CUSTOMER_EMAIL_IDS].sort(), [
    'customer_cancelled_order', 'customer_completed_order', 'customer_failed_order', 'customer_invoice', 'customer_new_account',
    'customer_note', 'customer_on_hold_order', 'customer_processing_order', 'customer_refunded_order', 'customer_reset_password',
  ])
  for (const id of WOO_NATIVE_CUSTOMER_EMAIL_IDS) assert.ok(WOO_CORE_CUSTOMER_EMAIL_IDS.includes(id), id)
})

test('the stays-in-woo set is exactly the owner ruling and WooCommerce owns each in every phase', () => {
  const stays = WOO_CUSTOMER_EMAIL_INVENTORY.filter((entry) => entry.disposition === 'stays-in-woo')
  assert.deepEqual(stays.flatMap((entry) => entry.wooEmailIds).sort(), ['customer_cancelled_order', 'customer_failed_order', 'customer_new_account', 'customer_note', 'customer_on_hold_order', 'customer_reset_password'])
  for (const entry of stays) {
    const row = ownershipRowFor('customer-email', entry.rowOperation)!
    assert.deepEqual([row.owners.P1, row.owners.P2, row.step], ['woocommerce-native', 'woocommerce-native', 'never'], entry.rowOperation)
  }
})

test('the refund e-mail is planned for IMS with no kind yet; the replaced e-mails move to IMS at step W', () => {
  const refund = WOO_CUSTOMER_EMAIL_INVENTORY.find((entry) => entry.rowOperation === 'refund')!
  assert.equal(refund.disposition, 'ims-planned')
  assert.deepEqual(refund.wooEmailIds, ['customer_refunded_order'])
  assert.equal(ownershipRowFor('customer-email', 'refund')!.owners.P2, 'IMS')
  for (const entry of WOO_CUSTOMER_EMAIL_INVENTORY.filter((e) => e.disposition === 'replaced-by-ims' || e.disposition === 'ims-planned')) {
    const row = ownershipRowFor('customer-email', entry.rowOperation)!
    assert.deepEqual([row.owners.P1, row.owners.P2, row.step], ['woocommerce-native', 'IMS', 'woocommerce'], entry.rowOperation)
  }
  // NATIVE_EMAIL_EXCLUSIVE is not extended to the refund e-mail until IMS sends it.
  assert.ok(!(WOO_NATIVE_CUSTOMER_EMAIL_IDS as readonly string[]).includes('customer_refunded_order'))
})
