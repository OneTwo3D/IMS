/**
 * Representative sales-order inputs, symbolic where the database mints ids: a line names its product by key (STD1 / STD2 / RED) and a manual rate override by key (red / zero).
 * Shared by the golden-row capture (tests/concurrency/sales-order-write-model.concurrent.test.ts, which runs them through the real createSalesOrder against a scratch database)
 * and the pure builder test (tests/domain/sales/sales-order-write-model.test.ts). `lineRates` is the rate each line resolves to in that scratch world (STD = 0.2, RED = 0.05, zero = 0).
 */
export type WriteCaseLine = {
  product: 'STD1' | 'STD2' | 'RED'
  qty: number
  unitPriceForeign: number
  discountAmount?: number
  discountStr?: string
  override?: 'red' | 'zero'
}

export type WriteCase = {
  key: string
  currency: 'GBP' | 'EUR' | 'USD'
  fxRate: number
  /** The order-default rate the header names (null: none). */
  orderRate: { name: string; value: number } | null
  pricesIncludeVat: boolean
  shippingForeign?: number
  shippingService?: string
  fees?: { description: string; amount: number }[]
  orderDiscountForeign?: number
  orderDiscountStr?: string
  lines: WriteCaseLine[]
  lineRates: number[]
}

export const WRITE_CASES: WriteCase[] = [
  {
    key: 'multi-line-exclusive-gbp', currency: 'GBP', fxRate: 1, orderRate: { name: 'ZQWM Std 20', value: 0.2 }, pricesIncludeVat: false,
    lines: [
      { product: 'STD1', qty: 3, unitPriceForeign: 12.345 },
      { product: 'STD2', qty: 1.5, unitPriceForeign: 99.99 },
      { product: 'RED', qty: 2, unitPriceForeign: 7.1 },
    ],
    lineRates: [0.2, 0.2, 0.05],
  },
  {
    key: 'inclusive-discounts-shipping-fee-gbp', currency: 'GBP', fxRate: 1, orderRate: { name: 'ZQWM Std 20', value: 0.2 }, pricesIncludeVat: true,
    shippingForeign: 12, shippingService: 'Courier', fees: [{ description: 'Handling', amount: 3.5 }],
    orderDiscountForeign: 10, orderDiscountStr: '10',
    lines: [
      { product: 'STD1', qty: 4, unitPriceForeign: 24, discountAmount: 9.6, discountStr: '10%' },
      { product: 'RED', qty: 1, unitPriceForeign: 10.5, discountAmount: 0.5 },
    ],
    lineRates: [0.2, 0.05],
  },
  {
    key: 'inclusive-eur-shipping-tax', currency: 'EUR', fxRate: 1.3, orderRate: { name: 'ZQWM Std 20', value: 0.2 }, pricesIncludeVat: true,
    shippingForeign: 14.99, shippingService: 'Express', orderDiscountForeign: 5.55, orderDiscountStr: '5.55',
    lines: [
      { product: 'STD1', qty: 7, unitPriceForeign: 19.99 },
      { product: 'STD2', qty: 2, unitPriceForeign: 3.33, discountAmount: 1.11 },
    ],
    lineRates: [0.2, 0.2],
  },
  {
    key: 'exclusive-usd-override-and-capped-discount', currency: 'USD', fxRate: 1.25, orderRate: { name: 'ZQWM Std 20', value: 0.2 }, pricesIncludeVat: false,
    shippingForeign: 8.75, fees: [{ description: 'Pallet', amount: 20 }, { description: 'Insurance', amount: 1.5 }],
    orderDiscountForeign: 100000, orderDiscountStr: '100000',
    lines: [
      { product: 'STD1', qty: 2, unitPriceForeign: 15.5, override: 'red' },
      { product: 'STD2', qty: 10, unitPriceForeign: 0.97, override: 'zero' },
      { product: 'RED', qty: 1, unitPriceForeign: 40 },
    ],
    lineRates: [0.05, 0, 0.05],
  },
  {
    key: 'no-header-rate-zero-override-eur', currency: 'EUR', fxRate: 1.3, orderRate: null, pricesIncludeVat: false,
    shippingForeign: 6, lines: [{ product: 'STD1', qty: 5, unitPriceForeign: 2.2, override: 'zero' }],
    lineRates: [0],
  },
]
