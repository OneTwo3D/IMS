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
