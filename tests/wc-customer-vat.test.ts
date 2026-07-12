import assert from 'node:assert/strict'
import test from 'node:test'
import * as fieldMappingNs from '../lib/connectors/woocommerce/sync/field-mapping.ts'
import type { WcFullOrder } from '../lib/connectors/woocommerce/sync/types.ts'

const { readWcCustomerVat } = 'default' in fieldMappingNs
  ? (fieldMappingNs.default as typeof import('../lib/connectors/woocommerce/sync/field-mapping.ts'))
  : fieldMappingNs

function order(partial: { meta?: Array<{ key: string; value: unknown }>; billing?: Record<string, unknown> }): WcFullOrder {
  return {
    meta_data: (partial.meta ?? []).map((m, i) => ({ id: i, key: m.key, value: m.value })),
    billing: { email: 'x@y.com', ...(partial.billing ?? {}) },
  } as unknown as WcFullOrder
}

test('readWcCustomerVat reads from the common EU/UK VAT meta keys and trims', () => {
  assert.equal(readWcCustomerVat(order({ meta: [{ key: '_billing_vat', value: ' GB 123 456 789 ' }] })), 'GB 123 456 789')
  assert.equal(readWcCustomerVat(order({ meta: [{ key: 'vat_number', value: 'IE1234567X' }] })), 'IE1234567X')
  assert.equal(readWcCustomerVat(order({ meta: [{ key: '_billing_eu_vat_number', value: 'DE999999999' }] })), 'DE999999999')
})

test('readWcCustomerVat falls back to billing-level fields (blocks checkout)', () => {
  assert.equal(readWcCustomerVat(order({ billing: { vat_number: 'FR12345678901' } })), 'FR12345678901')
})

test('readWcCustomerVat returns null when no VAT is present or it is blank', () => {
  assert.equal(readWcCustomerVat(order({})), null)
  assert.equal(readWcCustomerVat(order({ meta: [{ key: '_vat_number', value: '   ' }] })), null)
  assert.equal(readWcCustomerVat(order({ meta: [{ key: 'unrelated_key', value: 'X' }] })), null)
})
