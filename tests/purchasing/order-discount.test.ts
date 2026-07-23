import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyHeaderOrderDiscount,
  parseDiscountPercent,
  resolveHeaderOrderDiscountForeign,
} from '@/lib/domain/purchasing/order-discount'

// o3d-lx1: submitSupplierQuote must reapply the RFQ's header discount to the requoted subtotal (a
// percentage scales, a fixed amount is capped) using the SAME net/VAT split as createPurchaseOrder, so
// the persisted totals stay self-consistent.

test('parseDiscountPercent recognises percentage strings, rejects fixed/blank/negative', () => {
  assert.equal(parseDiscountPercent('10%'), 0.1)
  assert.equal(parseDiscountPercent('  7.5 % '), 0.075)
  assert.equal(parseDiscountPercent('.5%'), 0.005) // leading-dot form the PO form's parseFloat accepts
  assert.equal(parseDiscountPercent('0%'), 0)
  assert.equal(parseDiscountPercent('50.00'), null) // fixed amount
  assert.equal(parseDiscountPercent(null), null)
  assert.equal(parseDiscountPercent('abc'), null)
  assert.equal(parseDiscountPercent('-5%'), null)
})

test('a PERCENTAGE discount is re-evaluated against the requoted subtotal (net convention)', () => {
  // 10% of a 200 net subtotal = 20, regardless of the amount stored at RFQ time (which was for the old prices).
  const resolved = resolveHeaderOrderDiscountForeign({
    discountStr: '10%',
    originalDiscountForeign: 15, // stale, from the old prices — must be ignored for a percentage
    subtotalForeign: 200,
    taxForeign: 0,
    inclVat: false,
  })
  assert.equal(resolved, 20)
})

test('a PERCENTAGE discount uses the GROSS subtotal when prices include VAT', () => {
  // 10% of gross (200 net + 40 tax = 240) = 24.
  const resolved = resolveHeaderOrderDiscountForeign({
    discountStr: '10%',
    originalDiscountForeign: 0,
    subtotalForeign: 200,
    taxForeign: 40,
    inclVat: true,
  })
  assert.equal(resolved, 24)
})

test('a FIXED discount keeps its amount but is capped at the requoted subtotal', () => {
  assert.equal(
    resolveHeaderOrderDiscountForeign({ discountStr: '50', originalDiscountForeign: 50, subtotalForeign: 200, taxForeign: 0, inclVat: false }),
    50,
  )
  // Requote dropped the subtotal below the fixed discount — cap it so it can't exceed the goods value.
  assert.equal(
    resolveHeaderOrderDiscountForeign({ discountStr: '50', originalDiscountForeign: 50, subtotalForeign: 30, taxForeign: 0, inclVat: false }),
    30,
  )
})

test('applyHeaderOrderDiscount reduces net subtotal and tax proportionally (excl-VAT input)', () => {
  // 200 net + 40 tax (20%), fx 1. A 20 NET discount reduces the net by 20 and the tax by the same 10%
  // blend: netFrac = 200/240 = 0.8333, grossDisc = 20/0.8333 = 24, vat portion = 4.
  const out = applyHeaderOrderDiscount({
    subtotalForeign: 200, subtotalBase: 200, taxForeign: 40, taxBase: 40,
    orderDiscountForeign: 20, inclVat: false, fxRate: 1,
  })
  assert.equal(out.discountNetForeign, 20)
  assert.equal(out.discountVatForeign, 4)
  assert.equal(out.subtotalForeign, 180)
  assert.equal(out.taxForeign, 36)
  // Post-discount total is consistent: net 180 + tax 36 = 216 = gross 240 - gross discount 24.
})

test('applyHeaderOrderDiscount treats an incl-VAT input as a gross amount', () => {
  // 200 net + 40 tax, fx 1. A 24 GROSS discount → net 20 + vat 4 (netFrac 0.8333).
  const out = applyHeaderOrderDiscount({
    subtotalForeign: 200, subtotalBase: 200, taxForeign: 40, taxBase: 40,
    orderDiscountForeign: 24, inclVat: true, fxRate: 1,
  })
  assert.equal(out.discountNetForeign, 20)
  assert.equal(out.discountVatForeign, 4)
  assert.equal(out.subtotalForeign, 180)
  assert.equal(out.taxForeign, 36)
})

test('applyHeaderOrderDiscount converts base amounts by the FX rate', () => {
  // fx 2 (foreign per base): a 20 net foreign discount is 10 in base.
  const out = applyHeaderOrderDiscount({
    subtotalForeign: 200, subtotalBase: 100, taxForeign: 0, taxBase: 0,
    orderDiscountForeign: 20, inclVat: false, fxRate: 2,
  })
  assert.equal(out.discountNetForeign, 20)
  assert.equal(out.discountNetBase, 10)
  assert.equal(out.subtotalForeign, 180)
  assert.equal(out.subtotalBase, 90)
})

test('applyHeaderOrderDiscount is a no-op for a zero discount or empty subtotal', () => {
  const zeroDisc = applyHeaderOrderDiscount({
    subtotalForeign: 200, subtotalBase: 200, taxForeign: 40, taxBase: 40,
    orderDiscountForeign: 0, inclVat: false, fxRate: 1,
  })
  assert.equal(zeroDisc.subtotalForeign, 200)
  assert.equal(zeroDisc.taxForeign, 40)
  assert.equal(zeroDisc.discountNetForeign, 0)
})

test('a FIXED inclusive-VAT discount is reapplied as GROSS, not re-grossed-up (o3d-lx1)', () => {
  // The Codex scenario: a fixed header discount of 120 on a VAT-inclusive PO (200 net + 40 tax @ 20%).
  // Created inclusive, discountAmount 120 IS the gross reduction (100 net + 20 vat). On requote it must
  // resolve to 120 and split to net 100 / vat 20 — NOT be treated as a net 120 (which would gross up to
  // 144 and over-discount). This is why the PO now persists pricesIncludeVat.
  const resolved = resolveHeaderOrderDiscountForeign({
    discountStr: '120', originalDiscountForeign: 120, subtotalForeign: 200, taxForeign: 40, inclVat: true,
  })
  assert.equal(resolved, 120)
  const out = applyHeaderOrderDiscount({
    subtotalForeign: 200, subtotalBase: 200, taxForeign: 40, taxBase: 40,
    orderDiscountForeign: resolved, inclVat: true, fxRate: 1,
  })
  assert.equal(out.discountNetForeign, 100)
  assert.equal(out.discountVatForeign, 20)
  assert.equal(out.subtotalForeign, 100)
  assert.equal(out.taxForeign, 20)
})

test('applyHeaderOrderDiscount caps a discount larger than the gross subtotal at 100%', () => {
  const out = applyHeaderOrderDiscount({
    subtotalForeign: 100, subtotalBase: 100, taxForeign: 0, taxBase: 0,
    orderDiscountForeign: 999, inclVat: false, fxRate: 1,
  })
  assert.equal(out.subtotalForeign, 0) // never negative
  assert.equal(out.discountNetForeign, 100)
})
