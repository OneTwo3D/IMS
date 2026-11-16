import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeLineMargin,
  computePoMarginTotal,
  parseDiscountDecimal,
  type LineMarginInput,
} from '@/lib/domain/purchasing/line-margin'
import { toDecimal } from '@/lib/domain/math/decimal'

const base: LineMarginInput = {
  qty: 10,
  unitCost: 6,
  discount: '',
  purchaseUnitFactor: 1,
  taxRate: 0.2,
  pricesIncludeVat: false,
  fxRate: 1,
  salesPrice: '10.00',
  salesPriceTaxInclusive: false,
  salesVatRate: null,
}

function ok(input: Partial<LineMarginInput>) {
  const r = computeLineMargin({ ...base, ...input })
  assert.equal(r.kind, 'ok')
  return r as Extract<typeof r, { kind: 'ok' }>
}

test('plain margin: (price - cost) / price, amount per unit', () => {
  const r = ok({})
  assert.equal(r.marginPct, '40.00')
  assert.equal(r.marginAmount, '4')
  assert.equal(r.negative, false)
})

test('cost is converted at the PO rate: 1 base = rate foreign', () => {
  const r = ok({ unitCost: 12, fxRate: 2 }) // 12 foreign = 6 base
  assert.equal(r.cost, '6')
  assert.equal(r.marginPct, '40.00')
})

test('a missing, zero or negative FX rate refuses and is never defaulted to 1', () => {
  for (const fxRate of [null, 0, -1]) {
    const r = computeLineMargin({ ...base, fxRate })
    assert.equal(r.kind, 'refused')
    assert.equal(r.kind === 'refused' && r.reason, 'rate-unavailable')
    assert.equal(r.kind === 'refused' && r.message, 'Rate unavailable')
  }
})

test('VAT-inclusive entered prices are stripped of the line VAT before comparison', () => {
  const r = ok({ unitCost: 7.2, pricesIncludeVat: true, taxRate: 0.2 }) // 6.00 net
  assert.equal(r.cost, '6')
  assert.equal(r.marginPct, '40.00')
})

test('a VAT-inclusive stored sales price is stripped with the sales VAT rate', () => {
  const r = ok({ salesPrice: '12.00', salesPriceTaxInclusive: true, salesVatRate: 0.2 }) // 10 net
  assert.equal(r.salesPrice, '10')
  assert.equal(r.marginPct, '40.00')
})

test('an inclusive sales price with no resolved VAT rate refuses rather than assuming 0%', () => {
  const r = computeLineMargin({ ...base, salesPriceTaxInclusive: true, salesVatRate: null })
  assert.equal(r.kind === 'refused' && r.reason, 'sales-vat-unresolved')
})

test('line discount (percent and absolute) lowers the cost; purchase units convert to stock units', () => {
  assert.equal(ok({ discount: '10%' }).cost, '5.4')
  assert.equal(ok({ discount: '6' }).cost, '5.4') // 60 gross - 6 = 54 over 10
  // 10 cartons of 12 at 72 each -> 6 per stock unit
  const r = ok({ qty: 10, unitCost: 72, purchaseUnitFactor: 12 })
  assert.equal(r.cost, '6')
  assert.equal(r.stockQty, '120')
})

test('negative margin is flagged', () => {
  const r = ok({ unitCost: 12 })
  assert.equal(r.negative, true)
  assert.equal(r.marginPct, '-20.00')
  assert.equal(r.marginAmount, '-2')
})

test('no sales price, zero price and missing cost inputs refuse with a reason', () => {
  assert.equal((computeLineMargin({ ...base, salesPrice: null }) as { reason: string }).reason, 'no-sales-price')
  assert.equal((computeLineMargin({ ...base, salesPrice: '0' }) as { reason: string }).reason, 'no-sales-price')
  assert.equal((computeLineMargin({ ...base, unitCost: 0 }) as { reason: string }).reason, 'no-cost')
  assert.equal((computeLineMargin({ ...base, qty: 0 }) as { reason: string }).reason, 'no-cost')
})

test('no float drift: 0.1 + 0.2 style inputs stay exact', () => {
  const r = ok({ salesPrice: '0.3', unitCost: 0.1, qty: 1 })
  assert.equal(r.marginAmount, '0.2')
  assert.equal(r.marginPct, '66.67')
})

test('parseDiscountDecimal ignores junk', () => {
  assert.equal(parseDiscountDecimal('abc', toDecimal(100)).toFixed(), '0')
  assert.equal(parseDiscountDecimal('-5', toDecimal(100)).toFixed(), '0')
  assert.equal(parseDiscountDecimal('', toDecimal(100)).toFixed(), '0')
})

test('PO total covers only lines with a margin; the rest are left out, not zero', () => {
  const a = computeLineMargin({ ...base }) // sells 10, cost 6, 10 units
  const b = computeLineMargin({ ...base, salesPrice: '20', unitCost: 8, qty: 5 }) // sells 20, cost 8, 5 units
  const none = computeLineMargin({ ...base, salesPrice: null })
  const t = computePoMarginTotal([a, b, none])
  assert.equal(t.includedLines, 2)
  assert.equal(t.excludedLines, 1)
  assert.equal(t.salesValue, '200') // 100 + 100
  assert.equal(t.costValue, '100') // 60 + 40
  assert.equal(t.marginAmount, '100')
  assert.equal(t.marginPct, '50.00')
  assert.equal(t.negative, false)
})

test('PO total with no priced line has no percentage', () => {
  const t = computePoMarginTotal([computeLineMargin({ ...base, salesPrice: null })])
  assert.equal(t.marginPct, null)
  assert.equal(t.includedLines, 0)
  assert.equal(computePoMarginTotal([]).marginPct, null)
})

test('PO total can be negative', () => {
  const t = computePoMarginTotal([computeLineMargin({ ...base, unitCost: 12 })])
  assert.equal(t.negative, true)
  assert.equal(t.marginPct, '-20.00')
})
