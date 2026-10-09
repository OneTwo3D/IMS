import assert from 'node:assert/strict'
import test from 'node:test'
import { mapWcAddress } from '../lib/connectors/woocommerce/sync/field-mapping.ts'
import { resolvePushRecipient } from '../lib/domain/wms/push-recipient.ts'

const wcShipping = {
  first_name: ' Gina ', last_name: 'Gift', company: 'Gift Co', address_1: '1 Recipient St', address_2: 'Flat 3',
  city: 'Leeds', state: 'West Yorkshire', postcode: 'LS1 1AA', country: 'GB', phone: ' +44 113 496 0000 ',
}

test('mapWcAddress stores the recipient parts and keeps the historical composite line1', () => {
  const m = mapWcAddress(wcShipping)
  console.log(`# precondition: mapped keys = ${Object.keys(m).filter((k) => (m as Record<string, unknown>)[k] !== undefined).join(',')}`)
  assert.equal(m.firstName, 'Gina')
  assert.equal(m.lastName, 'Gift')
  assert.equal(m.company, 'Gift Co')
  assert.equal(m.address1, '1 Recipient St')
  assert.equal(m.phone, '+44 113 496 0000')
  assert.equal(m.line1, '1 Recipient St, Gift Co') // documents and screens still render this
  assert.equal(m.email, undefined) // WooCommerce core has no shipping email
})

test('a mapped WooCommerce shipping address round-trips into the push recipient (JSON as stored)', () => {
  const shipping = JSON.parse(JSON.stringify(mapWcAddress(wcShipping)))
  const billing = JSON.parse(JSON.stringify(mapWcAddress({
    first_name: 'Bea', last_name: 'Buyer', company: '', address_1: '9 Billing Rd', address_2: '', city: 'London',
    state: '', postcode: 'N1 1AA', country: 'GB', phone: '020 7946 0000', email: 'bea@example.com',
  })))
  const r = resolvePushRecipient({ shippingAddress: shipping, billingAddress: billing, customerName: 'Bea Buyer', customerEmail: null })
  assert.equal(r.addressSource, 'shipping')
  assert.equal(r.address.firstName, 'Gina')
  assert.equal(r.address.company, 'Gift Co')
  assert.equal(r.address.address1, '1 Recipient St') // company is NOT duplicated into the street line
  assert.equal(r.phone, '+44 113 496 0000')
  assert.equal(r.email, 'bea@example.com')
})

test('an empty WooCommerce shipping block maps to a stored shape that falls back to billing', () => {
  const empty = JSON.parse(JSON.stringify(mapWcAddress({
    first_name: '', last_name: '', company: '', address_1: '', address_2: '', city: '', state: '', postcode: '', country: '',
  })))
  assert.equal(empty.address1, '')
  const billing = JSON.parse(JSON.stringify(mapWcAddress({ ...wcShipping, first_name: 'Bea', last_name: 'Buyer' })))
  const r = resolvePushRecipient({ shippingAddress: empty, billingAddress: billing, customerName: null, customerEmail: null })
  assert.equal(r.addressSource, 'billing')
  assert.equal(r.address.firstName, 'Bea')
})
