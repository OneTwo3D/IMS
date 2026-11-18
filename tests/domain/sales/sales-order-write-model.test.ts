import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { buildSalesOrderWriteModel } from '@/lib/domain/sales/sales-order-write-model'
import { WRITE_CASES } from '../../fixtures/sales-order-write-cases'

/**
 * The money of a manual sales order is one pure function (buildSalesOrderWriteModel), extracted from createSalesOrder. The golden rows were written by the PRE-extraction createSalesOrder against a scratch
 * database (tests/concurrency/sales-order-write-model.concurrent.test.ts re-proves the whole written row through the real action on every concurrency run); this test pins the extracted arithmetic to the same
 * numbers with no database, on every unit run, for multi-line, discount, shipping + fees, foreign-currency, VAT-inclusive and VAT-exclusive inputs.
 * [mutation: change any rounding precision, the discount cap, or the shipping-tax basis in the builder: red]
 */
const golden = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/sales-order-write-model.golden.json'), 'utf8')) as Record<string, { header: Record<string, unknown>; lines: Record<string, unknown>[] }>

const HEADER_MONEY = ['subtotalForeign', 'shippingForeign', 'taxForeign', 'totalForeign', 'subtotalBase', 'shippingBase', 'taxBase', 'totalBase', 'discountAmount'] as const
const LINE_MONEY = ['unitPriceForeign', 'unitPriceBase', 'discountAmount', 'taxForeign', 'taxBase', 'totalForeign', 'totalBase'] as const

for (const c of WRITE_CASES) {
  test(`builder reproduces the golden rows of "${c.key}"`, () => {
    const want = golden[c.key]
    assert.ok(want, 'the golden holds this case')
    const model = buildSalesOrderWriteModel({
      fxRate: c.fxRate,
      vatRate: c.orderRate?.value ?? 0,
      pricesIncludeVat: c.pricesIncludeVat,
      shippingForeign: c.shippingForeign,
      fees: c.fees,
      orderDiscountForeign: c.orderDiscountForeign,
      lines: c.lines.map((l, i) => ({
        input: { productId: l.product, sku: `WM-${l.product}`, description: `Desc ${l.product}`, qty: l.qty, unitPriceForeign: l.unitPriceForeign, discountAmount: l.discountAmount, discountStr: l.discountStr },
        rate: c.lineRates[i],
        taxRateId: null,
      })),
    })
    for (const k of HEADER_MONEY) assert.equal(model.totals[k], Number(want.header[k]), `header ${k}`)
    assert.equal(model.lines.length, want.lines.length)
    for (const line of model.lines) {
      const row = want.lines.find((l) => l.sku === line.sku)
      assert.ok(row, `golden line for ${line.sku}`)
      for (const k of LINE_MONEY) assert.equal(line[k], Number(row[k]), `${line.sku} ${k}`)
      assert.equal(line.discountStr, row.discountStr)
      assert.equal(line.qty, Number(row.qty))
    }
  })
}

test('the builder is pure: the same input gives the same output and the input is not mutated', () => {
  const c = WRITE_CASES[1]
  const args = {
    fxRate: c.fxRate, vatRate: 0.2, pricesIncludeVat: true, shippingForeign: c.shippingForeign, fees: c.fees, orderDiscountForeign: c.orderDiscountForeign,
    lines: c.lines.map((l, i) => ({ input: { productId: 'p', sku: l.product, description: 'd', qty: l.qty, unitPriceForeign: l.unitPriceForeign, discountAmount: l.discountAmount }, rate: c.lineRates[i], taxRateId: null })),
  }
  const before = JSON.stringify(args)
  assert.deepEqual(buildSalesOrderWriteModel(args), buildSalesOrderWriteModel(args))
  assert.equal(JSON.stringify(args), before)
})

// ---------------------------------------------------------------------------------------------------
// The order discount taxed at the LINES' rates, not the header's (apportionDiscountTax).
// [mutation: tax the shares at vatRate instead of the line rate, or drop the line-gross cap: red]
// ---------------------------------------------------------------------------------------------------
const mixedLines = (rates: number[]) => rates.map((rate, i) => ({
  input: { productId: `p${i}`, sku: `S${i}`, description: 'd', qty: 1, unitPriceForeign: 100 },
  rate,
  taxRateId: null,
}))

test('exclusive mixed-rate order: a 20 discount over a 20% line and a 0% line takes 10 of net from each and 2 of tax from the 20% line only', () => {
  const base = { fxRate: 1, vatRate: 0.2, pricesIncludeVat: false, orderDiscountForeign: 20, lines: mixedLines([0.2, 0]) }
  const header = buildSalesOrderWriteModel(base)
  const apportioned = buildSalesOrderWriteModel({ ...base, apportionDiscountTax: true })
  assert.equal(header.totals.taxForeign, 20 - 4, 'header-rate: the discount takes 4 of VAT although half of it is zero-rated goods')
  assert.equal(apportioned.totals.taxForeign, 20 - 2)
  assert.equal(apportioned.totals.totalForeign, 200 - 20 + 18)
  assert.equal(apportioned.totals.discountAmount, 20)
})

test('exclusive mixed-rate order with the discount capped: header tax stays non-negative (the 5% / 0% / 20% golden shape)', () => {
  const c = WRITE_CASES.find((x) => x.key === 'exclusive-usd-override-and-capped-discount')!
  const args = {
    fxRate: c.fxRate, vatRate: 0.2, pricesIncludeVat: false, shippingForeign: c.shippingForeign, fees: c.fees, orderDiscountForeign: c.orderDiscountForeign,
    lines: c.lines.map((l, i) => ({ input: { productId: 'p', sku: l.product, description: 'd', qty: l.qty, unitPriceForeign: l.unitPriceForeign }, rate: c.lineRates[i], taxRateId: null })),
  }
  assert.ok(buildSalesOrderWriteModel(args).totals.taxForeign < 0, 'the golden header-rate behaviour: negative header tax')
  const fixed = buildSalesOrderWriteModel({ ...args, apportionDiscountTax: true })
  assert.ok(fixed.totals.taxForeign >= 0, `apportioned header tax ${fixed.totals.taxForeign}`)
  // Discount capped at the lines' own net; the VAT left is the shipping's alone.
  assert.equal(fixed.totals.discountAmount, fixed.totals.subtotalForeign)
  assert.equal(fixed.totals.taxForeign, Math.round(fixed.totals.shippingForeign * 0.2 * 10000) / 10000)
})

test('inclusive mixed-rate order: the gross discount is split by gross weight and each net share is stripped at its own rate', () => {
  // Lines net 100 @20% (gross 120) and 100 @0% (gross 100); a 22 gross discount splits 12 / 10.
  const m = buildSalesOrderWriteModel({ fxRate: 1, vatRate: 0.2, pricesIncludeVat: true, orderDiscountForeign: 22, apportionDiscountTax: true, lines: mixedLines([0.2, 0]).map((l) => ({ ...l, input: { ...l.input, unitPriceForeign: l.rate > 0 ? 120 : 100 } })) })
  assert.equal(m.totals.subtotalForeign, 200)
  assert.equal(m.totals.discountAmount, 22)
  assert.equal(m.totals.taxForeign, 20 - 2, 'net share 10 at 20% = 2 of VAT')
  assert.equal(m.totals.totalForeign, 200 - 20 + 18)
})

test('a single-rate order is priced the same either way, and the default (flag absent) is the header-rate behaviour', () => {
  const base = { fxRate: 1, vatRate: 0.2, pricesIncludeVat: false, orderDiscountForeign: 30, lines: mixedLines([0.2, 0.2]) }
  assert.deepEqual(buildSalesOrderWriteModel({ ...base, apportionDiscountTax: true }).totals, buildSalesOrderWriteModel(base).totals)
})
