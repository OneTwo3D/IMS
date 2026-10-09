import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePushRecipient } from '../lib/domain/wms/push-recipient.ts'
import { buildPushInput } from '../lib/domain/wms/order-push-sweep.ts'
import { buildPushPayload } from '../lib/connectors/mintsoft/api/order-push.ts'

// A stored address in the separate-parts shape the WooCommerce import writes (mapWcAddress).
const stored = (o: Record<string, unknown>) => ({ address1: '', ...o })

const billing = stored({
  firstName: 'Bea', lastName: 'Buyer', company: 'Buyer Ltd', address1: '9 Billing Rd',
  line1: '9 Billing Rd, Buyer Ltd', city: 'London', postcode: 'N1 1AA', country: 'GB',
  phone: '020 7946 0000', email: 'bea@example.com',
})

type Case = {
  name: string
  shipping: unknown
  billing?: unknown
  customerName?: string | null
  customerEmail?: string | null
  expect: {
    source: 'shipping' | 'billing'
    name: [string, string]
    company: string
    address1: string
    phone: string | null
    email: string | null
  }
}

const CASES: Case[] = [
  {
    name: 'gift order: recipient name, company, street and phone come from SHIPPING, not billing',
    shipping: stored({
      firstName: 'Gina', lastName: 'Gift', company: 'Gift Co', address1: '1 Recipient St',
      line1: '1 Recipient St, Gift Co', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB', phone: '0113 496 0000',
    }),
    billing,
    expect: { source: 'shipping', name: ['Gina', 'Gift'], company: 'Gift Co', address1: '1 Recipient St', phone: '0113 496 0000', email: 'bea@example.com' },
  },
  {
    name: 'shipping has no phone: falls back to the billing phone',
    shipping: stored({ firstName: 'Gina', lastName: 'Gift', address1: '1 Recipient St' }),
    billing,
    expect: { source: 'shipping', name: ['Gina', 'Gift'], company: '', address1: '1 Recipient St', phone: '020 7946 0000', email: 'bea@example.com' },
  },
  {
    name: 'shipping email wins over billing email when stored',
    shipping: stored({ firstName: 'Gina', address1: '1 Recipient St', email: ' gina@example.com ' }),
    billing,
    expect: { source: 'shipping', name: ['Gina', ''], company: '', address1: '1 Recipient St', phone: '020 7946 0000', email: 'gina@example.com' },
  },
  {
    name: 'shipping address blank: the whole billing address is used (never mixed field by field)',
    shipping: stored({ country: 'GB' }),
    billing,
    expect: { source: 'billing', name: ['Bea', 'Buyer'], company: 'Buyer Ltd', address1: '9 Billing Rd', phone: '020 7946 0000', email: 'bea@example.com' },
  },
  {
    name: 'company-only shipping address is not a destination: billing is used',
    shipping: stored({ company: 'Gift Co', phone: '0113 496 0000' }),
    billing,
    expect: { source: 'billing', name: ['Bea', 'Buyer'], company: 'Buyer Ltd', address1: '9 Billing Rd', phone: '020 7946 0000', email: 'bea@example.com' },
  },
  {
    name: 'first name but no street still counts as a recipient (plugin: first_name OR address_1)',
    shipping: stored({ firstName: 'Gina', city: 'Leeds' }),
    billing,
    expect: { source: 'shipping', name: ['Gina', ''], company: '', address1: '', phone: '020 7946 0000', email: 'bea@example.com' },
  },
  {
    name: 'street but no name: shipping is used and the customer name fills the name',
    shipping: stored({ address1: '1 Recipient St' }),
    billing,
    customerName: 'Pat Q Customer',
    expect: { source: 'shipping', name: ['Pat', 'Q Customer'], company: '', address1: '1 Recipient St', phone: '020 7946 0000', email: 'bea@example.com' },
  },
  {
    name: 'whitespace is trimmed and a whitespace-only value counts as absent',
    shipping: stored({ firstName: '  Gina ', lastName: '   ', address1: '  1 Recipient St  ', company: '  ', phone: '   ' }),
    billing: stored({ phone: '  020 7946 0000  ' }),
    customerName: null,
    expect: { source: 'shipping', name: ['Gina', ''], company: '', address1: '1 Recipient St', phone: '020 7946 0000', email: null },
  },
  {
    name: 'international phone formats pass through verbatim (only trimmed)',
    shipping: stored({ firstName: 'Ciara', address1: '2 Quay St', phone: ' +353 (0)1 234 5678 ext. 4 ' }),
    billing,
    expect: { source: 'shipping', name: ['Ciara', ''], company: '', address1: '2 Quay St', phone: '+353 (0)1 234 5678 ext. 4', email: 'bea@example.com' },
  },
  {
    name: 'no billing address and no phone anywhere: phone null, email from the customer account',
    shipping: stored({ firstName: 'Gina', address1: '1 Recipient St' }),
    billing: null,
    customerEmail: ' acct@example.com ',
    expect: { source: 'shipping', name: ['Gina', ''], company: '', address1: '1 Recipient St', phone: null, email: 'acct@example.com' },
  },
  {
    name: 'LEGACY row (only line1, no address1): read as it always was, company stays in the street line',
    shipping: { line1: '1 Old St, Old Co', city: 'York' },
    billing: null,
    customerName: 'Olive Old',
    expect: { source: 'shipping', name: ['Olive', 'Old'], company: '', address1: '1 Old St, Old Co', phone: null, email: null },
  },
  {
    name: 'LEGACY blank shipping with a usable billing row: billing is used',
    shipping: {},
    billing: { line1: '9 Billing Rd', city: 'London' },
    customerName: 'Bea Buyer',
    expect: { source: 'billing', name: ['Bea', 'Buyer'], company: '', address1: '9 Billing Rd', phone: null, email: null },
  },
  {
    name: 'nothing usable anywhere: shipping source, empty address, nulls (the push itself rejects this elsewhere)',
    shipping: null,
    billing: null,
    expect: { source: 'shipping', name: ['', ''], company: '', address1: '', phone: null, email: null },
  },
]

let reached = 0
for (const c of CASES) {
  test(`resolvePushRecipient: ${c.name}`, () => {
    const r = resolvePushRecipient({
      shippingAddress: c.shipping,
      billingAddress: c.billing,
      customerName: c.customerName ?? null,
      customerEmail: c.customerEmail ?? null,
    })
    reached += 1
    // Precondition: the case really ran through the resolver (printed so a silent skip is visible).
    console.log(`# precondition [${c.name}]: source=${r.addressSource} name=${r.address.firstName}|${r.address.lastName}`)
    assert.equal(r.addressSource, c.expect.source)
    assert.deepEqual([r.address.firstName, r.address.lastName], c.expect.name)
    assert.equal(r.address.company, c.expect.company)
    assert.equal(r.address.address1, c.expect.address1)
    assert.equal(r.phone, c.expect.phone)
    assert.equal(r.email, c.expect.email)
  })
}

test('table ran every case (match count printed)', () => {
  console.log(`# precondition: ${reached} of ${CASES.length} recipient cases executed`)
  assert.equal(reached, CASES.length)
  assert.ok(CASES.length >= 13)
})

test('Mintsoft payload for an order whose shipping address differs from billing (snapshot)', () => {
  const input = buildPushInput(
    {
      id: 'order-1', orderNumber: 'SO-2001', externalOrderNumber: '5001', currency: 'GBP',
      customerName: 'Bea Buyer', customerEmail: 'acct@example.com', customerVatNumber: null,
      shippingAddress: stored({
        firstName: 'Gina', lastName: 'Gift', company: 'Gift Co', address1: '1 Recipient St',
        address2: undefined, line1: '1 Recipient St, Gift Co', line2: 'Flat 3', city: 'Leeds', county: 'West Yorkshire',
        postcode: 'LS1 1AA', country: 'GB', phone: '+44 113 496 0000',
      }),
      billingAddress: billing,
      shippingService: null, subtotalForeign: 10, shippingForeign: 0, taxForeign: 2,
      taxRatePercent: 20, pricesIncludeVat: false, discountAmount: 0, totalForeign: 12,
      lines: [{ sku: 'SKU1', qty: 1, taxForeign: 2, totalForeign: 10, description: 'Widget' }],
    },
    '301',
  )
  const payload = buildPushPayload(input, { kind: 'name' })
  const recipientFields = {
    FirstName: payload.FirstName, LastName: payload.LastName, CompanyName: payload.CompanyName,
    Address1: payload.Address1, Address2: payload.Address2, Town: payload.Town, County: payload.County,
    PostCode: payload.PostCode, Country: payload.Country, Email: payload.Email, Phone: payload.Phone,
  }
  console.log(`# precondition: payload recipient FirstName=${String(payload.FirstName)} Phone=${String(payload.Phone)}`)
  assert.deepEqual(recipientFields, {
    FirstName: 'Gina', LastName: 'Gift', CompanyName: 'Gift Co',
    Address1: '1 Recipient St', Address2: 'Flat 3', Town: 'Leeds', County: 'West Yorkshire',
    PostCode: 'LS1 1AA', Country: 'GB', Email: 'bea@example.com', Phone: '+44 113 496 0000',
  })
  // None of the billing recipient's own details leak into the delivery fields.
  const serialised = JSON.stringify(recipientFields)
  assert.ok(!serialised.includes('Buyer'), 'billing name/company must not appear')
  assert.ok(!serialised.includes('9 Billing Rd'), 'billing street must not appear')
  assert.ok(!serialised.includes('020 7946 0000'), 'billing phone must not appear when shipping has one')
})
