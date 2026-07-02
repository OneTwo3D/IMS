import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLines,
  orderTotalDriftPence,
  readAddress,
} from '../lib/domain/wms/order-push-sweep.ts'

const baseOrder = {
  subtotalForeign: 0,
  taxForeign: 0,
  taxRatePercent: null as unknown,
  shippingForeign: 0,
  discountAmount: 0,
  totalForeign: 0,
  pricesIncludeVat: false,
}

test('orderTotalDriftPence: consistent VAT-exclusive order → 0 drift', () => {
  // subtotal 100 + tax 20 + shipping 5 − discount 0 = 125
  assert.equal(orderTotalDriftPence({ ...baseOrder, subtotalForeign: 100, taxForeign: 20, shippingForeign: 5, totalForeign: 125 }), 0)
})

test('orderTotalDriftPence: VAT-exclusive order with a net discount reconciles', () => {
  // subtotal 100 + tax 18 − discount 10 (net) = 108
  assert.equal(orderTotalDriftPence({ ...baseOrder, subtotalForeign: 100, taxForeign: 18, discountAmount: 10, totalForeign: 108 }), 0)
})

test('orderTotalDriftPence: VAT-inclusive discount adds back its embedded VAT (real SO-CBINCL case)', () => {
  // The order that a naive subtotal+tax+shipping−discount guard would wrongly flag:
  // subtotal 100 (net) + tax 18 − discount 12 (gross = 10 net + 2 VAT @20%) → total 108.
  assert.equal(
    orderTotalDriftPence({ ...baseOrder, subtotalForeign: 100, taxForeign: 18, taxRatePercent: 0.2, discountAmount: 12, totalForeign: 108, pricesIncludeVat: true }),
    0,
  )
})

test('orderTotalDriftPence: VAT-inclusive discount derives the rate when taxRatePercent is absent', () => {
  // Same order but no named rate — effective rate tax/(total−tax) = 18/90 = 0.2 → still reconciles.
  assert.equal(
    orderTotalDriftPence({ ...baseOrder, subtotalForeign: 100, taxForeign: 18, taxRatePercent: null, discountAmount: 12, totalForeign: 108, pricesIncludeVat: true }),
    0,
  )
})

test('orderTotalDriftPence: a genuinely mis-totalled order is flagged (in pence)', () => {
  // subtotal 100 + tax 20 = 120, but total says 118 → 200p drift.
  assert.equal(orderTotalDriftPence({ ...baseOrder, subtotalForeign: 100, taxForeign: 20, totalForeign: 118 }), 200)
})

test('orderTotalDriftPence: sub-penny rounding noise stays within tolerance', () => {
  // 33.33 + 6.67 = 40.00 vs 40.004 → 0.4p → rounds to 0p.
  assert.equal(orderTotalDriftPence({ ...baseOrder, subtotalForeign: 33.33, taxForeign: 6.67, totalForeign: 40.004 }), 0)
})

test('buildLines derives per-unit ex-VAT (totalForeign is NET) and per-unit VAT', () => {
  const lines = buildLines([
    { sku: 'A', qty: 2, taxForeign: 4, totalForeign: 20, description: 'Widget' },
  ])
  assert.deepEqual(lines, [
    { sku: 'A', quantity: 2, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' },
  ])
})

test('buildLines guards qty 0 (treats as 1) and nulls an empty description', () => {
  const lines = buildLines([{ sku: 'B', qty: 0, taxForeign: 0, totalForeign: 5, description: '' }])
  assert.equal(lines[0].quantity, 1)
  assert.equal(lines[0].unitPriceExVat, 5)
  assert.equal(lines[0].description, null)
})

test('buildLines fails the order on a line with no SKU (no silent drop)', () => {
  assert.throws(
    () => buildLines([
      { sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'ok' },
      { sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'no sku' },
    ]),
    /no SKU/i,
  )
})

test('buildLines coerces stringly/Decimal-like numeric inputs (Prisma Decimal arrives as a string)', () => {
  // SalesOrderLine qty/totals are Prisma.Decimal at runtime → stringify via num().
  const lines = buildLines([{ sku: 'C', qty: '3', taxForeign: '6', totalForeign: '30', description: 'D' }])
  assert.deepEqual(lines, [{ sku: 'C', quantity: 3, unitPriceExVat: 10, unitPriceVat: 2, description: 'D' }])
})

test('readAddress maps the stored shape and splits the recipient name', () => {
  const addr = readAddress(
    { line1: '1 High St', line2: 'Flat 2', city: 'Leeds', county: 'WY', postcode: 'LS1 1AA', country: 'GB' },
    'Jane Doe',
  )
  assert.deepEqual(addr, {
    firstName: 'Jane', lastName: 'Doe', company: '',
    address1: '1 High St', address2: 'Flat 2', town: 'Leeds', county: 'WY', postCode: 'LS1 1AA', country: 'GB',
  })
})

test('readAddress accepts alternate key spellings and a multi-word surname', () => {
  const addr = readAddress({ address_1: '5 Mill Rd', town: 'York', postCode: 'YO1 2BB' }, 'Mary Jane Watson')
  assert.equal(addr.address1, '5 Mill Rd')
  assert.equal(addr.town, 'York')
  assert.equal(addr.postCode, 'YO1 2BB')
  assert.equal(addr.firstName, 'Mary')
  assert.equal(addr.lastName, 'Jane Watson')
})

test('readAddress is safe on a missing/non-object payload or empty name', () => {
  const empty = readAddress(null, null)
  assert.equal(empty.firstName, '')
  assert.equal(empty.address1, '')
  assert.equal(empty.country, '')
  assert.equal(readAddress({}, 'Cher').lastName, '')
})
