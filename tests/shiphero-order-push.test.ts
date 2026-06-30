import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildShipheroCreateInput,
  buildShipheroUpdateAddress,
  planShipheroLineAmendments,
} from '../lib/connectors/shiphero/api/order-push.ts'
import type { WmsOrderPushInput, WmsOrderPushLine } from '../lib/connectors/wms/types.ts'

const wmsLine = (sku: string, quantity: number): WmsOrderPushLine => ({
  sku, quantity, unitPriceExVat: 10, unitPriceVat: 2, description: sku,
})

const shLine = (id: string, sku: string, quantity: number) => ({ id, sku, quantity })

const SAMPLE_INPUT: WmsOrderPushInput = {
  orderNumber: 'SO-1001',
  externalReference: 'order-id-abc',
  externalWarehouseId: 'V2FyZWhvdXNlOjExNzkw',
  currency: 'GBP',
  shippingAddress: {
    firstName: 'Jane', lastName: 'Doe', company: 'Acme',
    address1: '1 High St', address2: 'Flat 2', town: 'Leeds', county: 'West Yorkshire', postCode: 'LS1 1AA', country: 'GB',
  },
  email: 'jane@example.com',
  phone: '0123',
  vatNumber: null,
  comments: null,
  courierService: 'Royal Mail Tracked 24',
  totalVat: 4.001,
  shippingExVat: 3.5,
  shippingVat: 0.7,
  discountExVat: 1,
  discountVat: 0.2,
  lines: [
    { sku: 'SKU1', quantity: 2, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' },
  ],
}

type CreateInput = ReturnType<typeof buildShipheroCreateInput>

test('buildShipheroCreateInput maps the canonical create fields', () => {
  const p = buildShipheroCreateInput(SAMPLE_INPUT)
  assert.equal(p.partner_order_id, 'order-id-abc') // canonical IMS↔ShipHero linkage
  assert.equal(p.order_number, 'SO-1001')
  assert.equal(p.shop_name, 'IMS')
  assert.equal(p.fulfillment_status, 'pending')
  assert.equal(p.email, 'jane@example.com')
})

test('buildShipheroCreateInput maps the address onto ShipHero address1/city/zip/country shape', () => {
  const addr = buildShipheroCreateInput(SAMPLE_INPUT).shipping_address as Record<string, unknown>
  assert.equal(addr.first_name, 'Jane')
  assert.equal(addr.address1, '1 High St')
  assert.equal(addr.address2, 'Flat 2')
  assert.equal(addr.city, 'Leeds')
  assert.equal(addr.state, 'West Yorkshire')
  assert.equal(addr.zip, 'LS1 1AA')
  assert.equal(addr.country, 'GB')
  assert.equal(addr.phone, '0123')
  // billing falls back to the same address (push input has shipping only).
  assert.deepEqual(buildShipheroCreateInput(SAMPLE_INPUT).billing_address, addr)
})

test('buildShipheroCreateInput emits string money fields: subtotal/tax/discount/total + gross shipping', () => {
  const p = buildShipheroCreateInput(SAMPLE_INPUT)
  assert.equal(p.subtotal, '20.00') // 2 × 10 ex-VAT
  assert.equal(p.total_tax, '4.00') // rounded from 4.001
  assert.equal(p.total_discounts, '1.20') // discountExVat + discountVat
  // total_price = goods gross (20 + 4) + shipping gross (3.5 + 0.7) = 28.20
  assert.equal(p.total_price, '28.20')
  assert.deepEqual(p.shipping_lines, { title: 'Royal Mail Tracked 24', price: '4.20' })
})

test('buildShipheroCreateInput omits shipping_lines when there is no courier and no shipping cost', () => {
  const noShip: WmsOrderPushInput = { ...SAMPLE_INPUT, courierService: null, shippingExVat: 0, shippingVat: 0 }
  assert.equal('shipping_lines' in (buildShipheroCreateInput(noShip) as CreateInput), false)
})

test('buildShipheroCreateInput builds a minimal unit line item (no fulfilment/warehouse fields on create)', () => {
  const lines = buildShipheroCreateInput(SAMPLE_INPUT).line_items as Array<Record<string, unknown>>
  assert.equal(lines.length, 1)
  // Create lines mirror the reference plugin's _build_create_input — the
  // fulfillment_status / quantity_pending_fulfillment / warehouse_id fields belong to
  // order_add_line_items, not order_create.
  assert.deepEqual(lines[0], {
    sku: 'SKU1',
    partner_line_item_id: 'order-id-abc:SKU1',
    quantity: 2,
    price: '10.00', // unit price ex-VAT
    product_name: 'Widget',
  })
})

test('buildShipheroCreateInput disambiguates a repeated SKU with a hyphen counter (unique partner_line_item_id)', () => {
  const dupe: WmsOrderPushInput = {
    ...SAMPLE_INPUT,
    lines: [
      { sku: 'DUP', quantity: 1, unitPriceExVat: 5, unitPriceVat: 1, description: 'A' },
      { sku: 'DUP', quantity: 1, unitPriceExVat: 5, unitPriceVat: 1, description: 'B' },
    ],
  }
  const ids = (buildShipheroCreateInput(dupe).line_items as Array<{ partner_line_item_id: string }>)
    .map((l) => l.partner_line_item_id)
  assert.deepEqual(ids, ['order-id-abc:DUP', 'order-id-abc:DUP-1'])
})

test('buildShipheroUpdateAddress uses the update shape: state_code/country_code + email/phone inside the address', () => {
  const addr = buildShipheroUpdateAddress(SAMPLE_INPUT)
  // CreateOrderInput accepts plain state/country; UpdateOrderInput also wants the _code forms.
  assert.equal(addr.state, 'West Yorkshire')
  assert.equal(addr.state_code, 'West Yorkshire')
  assert.equal(addr.country, 'GB')
  assert.equal(addr.country_code, 'GB')
  // email + phone live inside the address block on update (not top-level).
  assert.equal(addr.email, 'jane@example.com')
  assert.equal(addr.phone, '0123')
})

test('buildShipheroUpdateAddress omits empty fields so an amend never blanks an unset field', () => {
  const sparse: WmsOrderPushInput = {
    ...SAMPLE_INPUT,
    email: null,
    phone: null,
    shippingAddress: { ...SAMPLE_INPUT.shippingAddress, company: '', address2: '', county: '' },
  }
  const addr = buildShipheroUpdateAddress(sparse)
  assert.equal('company' in addr, false)
  assert.equal('address2' in addr, false)
  assert.equal('state' in addr, false)
  assert.equal('state_code' in addr, false)
  assert.equal('email' in addr, false)
  assert.equal('phone' in addr, false)
  assert.equal(addr.address1, '1 High St') // populated field still sent
})

test('buildShipheroUpdateAddress returns {} for an unusable address (no street or no country)', () => {
  const noStreet: WmsOrderPushInput = {
    ...SAMPLE_INPUT,
    shippingAddress: { ...SAMPLE_INPUT.shippingAddress, address1: '', address2: '' },
  }
  assert.deepEqual(buildShipheroUpdateAddress(noStreet), {})
  const noCountry: WmsOrderPushInput = {
    ...SAMPLE_INPUT,
    shippingAddress: { ...SAMPLE_INPUT.shippingAddress, country: '' },
  }
  assert.deepEqual(buildShipheroUpdateAddress(noCountry), {})
})

test('buildShipheroCreateInput maps comments to packing_note (and omits it when absent)', () => {
  assert.equal('packing_note' in buildShipheroCreateInput(SAMPLE_INPUT), false) // SAMPLE has comments: null
  const withNote = buildShipheroCreateInput({ ...SAMPLE_INPUT, comments: 'Leave with neighbour' })
  assert.equal(withNote.packing_note, 'Leave with neighbour')
})

test('planShipheroLineAmendments: reduces a partially-refunded line to its netted quantity (keyed by ShipHero line id)', () => {
  const current = [shLine('L11', 'A', 3), shLine('L12', 'B', 1)]
  const plan = planShipheroLineAmendments(current, [wmsLine('A', 1), wmsLine('B', 1)])
  assert.deepEqual(plan, [{ kind: 'update', lineItemId: 'L11', quantity: 1 }])
})

test('planShipheroLineAmendments: removes a line refunded down to zero (or gone)', () => {
  const current = [shLine('L11', 'A', 2), shLine('L12', 'B', 1)]
  const plan = planShipheroLineAmendments(current, [wmsLine('B', 1)])
  assert.deepEqual(plan, [{ kind: 'remove', lineItemId: 'L11' }])
})

test('planShipheroLineAmendments: no change when quantities already match', () => {
  assert.deepEqual(planShipheroLineAmendments([shLine('L11', 'A', 2)], [wmsLine('A', 2)]), [])
})

test('planShipheroLineAmendments: adds a desired line not yet on the order, carrying its quantity', () => {
  const plan = planShipheroLineAmendments([shLine('L11', 'A', 1)], [wmsLine('A', 1), wmsLine('C', 2)])
  assert.deepEqual(plan, [{ kind: 'add', line: wmsLine('C', 2), quantity: 2 }])
})

test('planShipheroLineAmendments: aggregates a SKU split across lines and consolidates duplicate rows (remove before update)', () => {
  const current = [shLine('L11', 'A', 4), shLine('L12', 'A', 1)]
  const plan = planShipheroLineAmendments(current, [wmsLine('A', 2), wmsLine('A', 1)])
  // desired total = 3: duplicate row removed first, then the primary set to 3 (never overstates).
  assert.deepEqual(plan, [
    { kind: 'remove', lineItemId: 'L12' },
    { kind: 'update', lineItemId: 'L11', quantity: 3 },
  ])
})

test('planShipheroLineAmendments: matches on trimmed SKUs so an unchanged order yields no writes', () => {
  assert.deepEqual(planShipheroLineAmendments([shLine('L11', ' A ', 2)], [wmsLine('A', 2)]), [])
})
