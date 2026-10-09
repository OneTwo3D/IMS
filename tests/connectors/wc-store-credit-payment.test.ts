import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkWcStoreCreditReconciles,
  classifyWcCouponLines,
  describeWcCouponRefusal,
  planWcOrderCoupons,
  type WcCouponPlan,
} from '@/lib/connectors/woocommerce/sync/coupon-classification'
import { mapWcOrderDiscount, resolveWcOrderLevelDiscount } from '@/lib/connectors/woocommerce/sync/field-mapping'
import type { WcCouponLine, WcMeta } from '@/lib/connectors/woocommerce/sync/types'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * Store credit is a PAYMENT, not a discount.
 *
 * Smart Coupons store credit reaches `coupon_lines[]` like any coupon, but WooCommerce takes it off the
 * order TOTAL without reducing a single line. Summing every coupon (the old `mapWcOrderDiscount`) therefore
 * made the whole credit the "unallocated residual" and stored it as `SalesOrder.discountAmount`, which
 * Mintsoft then received as `DiscountTotalExVat`.
 *
 * Every arm prints its PRECONDITION (what the fixture actually is) before it asserts the outcome, so an arm
 * that examines nothing cannot pass silently.
 */

let metaId = 1
const meta = (key: string, value: unknown): WcMeta => ({ id: metaId++, key, value } as WcMeta)
const info = (type: string, code = 'x') => meta('coupon_info', JSON.stringify([7, code, type, '50']))

function coupon(code: string, discount: string, type: string | null, extra: Partial<WcCouponLine> = {}): WcCouponLine {
  return {
    id: metaId++,
    code,
    discount,
    discount_tax: '0.00',
    meta_data: type === null ? [] : [info(type, code)],
    ...extra,
  }
}

function plan(couponLines: WcCouponLine[], lineDiscountTotal: number, orderMeta: WcMeta[] = []): WcCouponPlan {
  return planWcOrderCoupons({
    couponLines,
    orderMeta,
    lineDiscountTotalForeign: toDecimal(lineDiscountTotal),
    currency: 'GBP',
    resolveResidual: (args) => resolveWcOrderLevelDiscount(args),
  })
}

function precondition(name: string, facts: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION ${name}: ${JSON.stringify(facts)}`)
}

const num = (d: Decimal) => d.toNumber()

// ---------------------------------------------------------------------------------------------------
// The exact repro from the bead, through the two functions the importer composes.
// ---------------------------------------------------------------------------------------------------

test('PURE STORE CREDIT (the bead repro): no order-level discount, the credit is held as a payment', () => {
  // £10 net + £2 VAT of Smart Coupons credit, lines untouched (line discounts 0).
  const lines = [coupon('storecredit', '10.00', 'smart_coupon', { discount_tax: '2.00' })]
  const discountSide = mapWcOrderDiscount(lines)
  const residual = resolveWcOrderLevelDiscount({
    couponTotalForeign: discountSide.discountAmount,
    lineDiscountTotalForeign: 0,
    currency: 'GBP',
  })
  const result = plan(lines, 0)
  precondition('pure credit', {
    couponLines: lines.length,
    type: 'smart_coupon',
    lineDiscountTotal: 0,
    mapWcOrderDiscountAmount: discountSide.discountAmount,
    orderLevelDiscount: residual.orderLevelDiscount,
  })
  assert.equal(lines.length, 1, 'precondition: exactly one coupon line was examined')
  assert.equal(discountSide.discountAmount, 0, 'the credit is not in the discount sum')
  assert.equal(residual.orderLevelDiscount, 0, 'so the order-level discount is nothing (was 10 on the old sum-everything mapping)')
  assert.equal(num(result.storeCreditForeign), 12, 'the credit is held GROSS (net + tax) as a payment')
  assert.deepEqual(result.storeCreditCodes, ['storecredit'])
  assert.equal(result.orderLevelDiscount, 0)
  assert.equal(result.refusal, null)
})

test('CREDIT + PERCENTAGE coupon: only the percentage coupon is a discount, and it is already on the lines', () => {
  const lines = [
    coupon('tenpercent', '5.00', 'percent'),
    coupon('storecredit', '10.00', 'smart_coupon', { discount_tax: '2.00' }),
  ]
  const result = plan(lines, 5)
  precondition('credit + percent', { kinds: classifyWcCouponLines(lines).lines.map((l) => l.kind), lineDiscountTotal: 5 })
  assert.deepEqual(classifyWcCouponLines(lines).lines.map((l) => l.kind), ['DISCOUNT', 'STORE_CREDIT'])
  assert.equal(num(result.genuineCouponNet), 5, 'only the genuine coupon counts towards the allocation')
  assert.equal(result.orderLevelDiscount, 0, 'the 5 is on the lines, so nothing is left at order level (old mapping: 10)')
  assert.equal(num(result.storeCreditForeign), 12)
  assert.equal(result.refusal, null)
})

test('CREDIT + FIXED coupon with an unallocated remainder: only the genuine remainder is a discount', () => {
  const lines = [
    coupon('fiver', '5.00', 'fixed_cart'),
    coupon('storecredit', '10.00', 'smart_coupon'),
  ]
  // Woo put only 3 of the 5 on the lines; the other 2 is a residual of the GENUINE coupon.
  const result = plan(lines, 3)
  precondition('credit + fixed', { genuineNet: 5, lineDiscountTotal: 3, creditNet: 10 })
  assert.equal(result.orderLevelDiscount, 2, 'the genuine coupon residual survives (today\'s y14 logic, unchanged)')
  assert.equal(num(result.storeCreditForeign), 10, 'and the credit is still not folded into it (old mapping: 12)')
  assert.equal(result.refusal, null, 'the fixed_cart type is known, so a residual of it is not ambiguous')
})

test('UNKNOWN coupon type with money NOT on the lines REFUSES instead of guessing', () => {
  const lines = [coupon('mystery', '10.00', 'acme_future_type')]
  const result = plan(lines, 0)
  precondition('unknown unallocated', { type: 'acme_future_type', couponNet: 10, lineDiscountTotal: 0, unallocated: result.unallocated })
  assert.equal(result.unallocated, 10, 'precondition: there IS unallocated money for the ambiguity to bite')
  assert.equal(result.refusal?.kind, 'UNKNOWN_COUPON_TYPE')
  assert.equal(num(result.storeCreditForeign), 0, 'never silently treated as credit')
  const text = describeWcCouponRefusal('1001', result.refusal!)
  assert.match(text, /order 1001 was NOT imported/)
  assert.match(text, /mystery \[acme_future_type: the coupon type "acme_future_type" is not one IMS recognises\]/)
})

test('a coupon with NO recorded type and money off the lines also refuses (absence is not "discount")', () => {
  const result = plan([coupon('legacy', '10.00', null)], 0)
  precondition('no type', { metaEntries: 0, unallocated: result.unallocated })
  assert.equal(result.refusal?.kind, 'UNKNOWN_COUPON_TYPE')
  assert.match(describeWcCouponRefusal('1002', result.refusal!), /WooCommerce recorded no coupon type/)
})

test('UNKNOWN type fully allocated into the lines is harmless and is carried exactly as before', () => {
  const result = plan([coupon('mystery', '10.00', 'acme_future_type')], 10)
  precondition('unknown allocated', { unallocated: result.unallocated, lineDiscountTotal: 10 })
  assert.equal(result.unallocated, 0)
  assert.equal(result.refusal, null, 'nothing is ambiguous when the money is on the lines')
  assert.equal(result.orderLevelDiscount, 0)
  assert.equal(num(result.storeCreditForeign), 0)
})

test('ZERO store credit: no payment recorded, nothing refused', () => {
  const result = plan([coupon('storecredit', '0.00', 'smart_coupon')], 0)
  precondition('zero credit', { net: 0, kind: classifyWcCouponLines([coupon('storecredit', '0.00', 'smart_coupon')]).lines[0].kind })
  assert.equal(num(result.storeCreditForeign), 0)
  assert.equal(result.orderLevelDiscount, 0)
  assert.equal(result.refusal, null)
})

test('the legacy coupon_data record is read, and a disagreement between records is a conflict, not a pick', () => {
  const legacy = { ...coupon('old', '10.00', null), meta_data: [meta('coupon_data', { id: 5, code: 'old', discount_type: 'smart_coupon', amount: '50' })] }
  assert.equal(classifyWcCouponLines([legacy]).lines[0].kind, 'STORE_CREDIT')
  const conflicted = { ...coupon('both', '10.00', null), meta_data: [info('smart_coupon', 'both'), meta('coupon_data', { discount_type: 'fixed_cart' })] }
  const c = classifyWcCouponLines([conflicted]).lines[0]
  precondition('legacy/conflict', { legacy: 'coupon_data=smart_coupon', conflict: 'coupon_info=smart_coupon vs coupon_data=fixed_cart' })
  assert.equal(c.kind, 'UNKNOWN')
  assert.match(c.unknownReason ?? '', /coupon_info says "smart_coupon" but coupon_data says "fixed_cart"/)
})

test('the order-level smart_coupons_contribution map (what the production plugin reads) identifies credit when the item has no type', () => {
  const orderMeta = [meta('smart_coupons_contribution', { nr5zg9hl5zs3d: 45.57 })]
  const lines = [coupon('nr5zg9hl5zs3d', '36.46', null, { discount_tax: '9.11' })]
  const result = plan(lines, 0, orderMeta)
  precondition('contribution only', { contribution: 'nr5zg9hl5zs3d', itemMeta: 0 })
  assert.equal(num(result.storeCreditForeign), 45.57)
  assert.equal(result.refusal, null)
  // ...and the same code recorded as a contribution while the item says it is a fixed_cart is a conflict.
  const clash = plan([coupon('nr5zg9hl5zs3d', '36.46', 'fixed_cart')], 0, orderMeta)
  assert.equal(clash.refusal?.kind, 'UNKNOWN_COUPON_TYPE')
})

test('a store-credit amount that cannot be read is refused even when it would look allocated', () => {
  const result = plan([coupon('storecredit', 'not-a-number', 'smart_coupon')], 0)
  precondition('unreadable credit', { discount: 'not-a-number' })
  assert.equal(result.refusal?.kind, 'CREDIT_UNREADABLE')
  assert.equal(num(result.storeCreditForeign), 0)
})

// ---------------------------------------------------------------------------------------------------
// The reconciliation that proves the credit is not ALSO inside the lines.
// ---------------------------------------------------------------------------------------------------

const reconcile = (overrides: Partial<Parameters<typeof checkWcStoreCreditReconciles>[0]> = {}) =>
  checkWcStoreCreditReconciles({
    subtotalForeign: toDecimal(100),
    taxForeign: toDecimal(20),
    shippingForeign: toDecimal(0),
    orderLevelDiscountForeign: toDecimal(0),
    storeCreditForeign: toDecimal(30),
    orderTotalForeign: toDecimal(90),
    currency: 'GBP',
    componentCount: 2,
    ...overrides,
  })

test('credit that is NOT in the lines reconciles: 100 + 20 - 30 = 90', () => {
  precondition('reconciles', { subtotal: 100, tax: 20, credit: 30, total: 90 })
  assert.deepEqual(reconcile(), { ok: true })
})

test('credit that ALSO reduced the lines does not reconcile (it would be taken off twice)', () => {
  // "Apply before tax": Woo reduced the lines by the credit (goods 100 -> 70, VAT 20 -> 14) and the order
  // total is therefore 84 with NO further deduction. Counting 30 as a payment as well would take it twice.
  const result = reconcile({ subtotalForeign: toDecimal(70), taxForeign: toDecimal(14), orderTotalForeign: toDecimal(84) })
  precondition('double-counted', { subtotal: 70, tax: 14, credit: 30, total: 84 })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && num(result.difference), -30, 'expected 54 from the lines less the credit, Woo says 84')
})

test('rounding inside the tolerance does not refuse an honest credit order', () => {
  const result = reconcile({ orderTotalForeign: toDecimal(90.01) })
  precondition('rounding', { difference: -0.01, componentCount: 2 })
  assert.equal(result.ok, true)
})

// ---------------------------------------------------------------------------------------------------
// Operator text.
// ---------------------------------------------------------------------------------------------------

test('the refusal text says only what is true: the order was not created, nothing went anywhere', () => {
  const text = describeWcCouponRefusal('1003', { kind: 'CREDIT_NOT_RECONCILED', reason: 'it carries 10.00 of store credit but the lines differ.' })
  precondition('refusal text', { length: text.length })
  assert.match(text, /No order was created in IMS, so nothing was sent to the warehouse or the ledger for it\./)
  assert.doesNotMatch(text, /\b(reverse|void|re-?post)\b/i, 'no money instruction at all')
})

// ---------------------------------------------------------------------------------------------------
// The importer is wired to the planner. There is no harness that runs importWcOrder end to end without a
// database, so this pins the wiring in the source: presence AND order, never mere presence.
// ---------------------------------------------------------------------------------------------------

test('importWcOrder: classifies before it writes, refuses before the create, and keeps the credit out of the discount', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  const body = src.slice(src.indexOf('export async function importWcOrder('))
  const at = (needle: string) => body.indexOf(needle)
  const create = at('tx.salesOrder.create({')
  precondition('importer wiring', {
    plan: at('planWcOrderCoupons({'), refuse: at("action: 'wc_coupon_import_refused'"), reconcile: at('checkWcStoreCreditReconciles({'), create,
  })
  assert.ok(create > 0, 'the order create is still where this scan expects it')
  for (const needle of ['planWcOrderCoupons({', "action: 'wc_coupon_import_refused'", 'checkWcStoreCreditReconciles({']) {
    assert.ok(at(needle) > 0 && at(needle) < create, `${needle} must exist and run before the order is created`)
  }
  assert.match(body, /discountAmount: orderLevelDiscountForeign,\s*\/\/[^\n]*\n\s*storeCreditForeign,/, 'the create writes the credit to its own column right beside the discount')
  assert.doesNotMatch(body, /mapWcOrderDiscount\(wcOrder\.coupon_lines\)/, 'the sum-every-coupon mapping is gone from the import')
  assert.match(body, /_registerPayment: !!wcOrder\.date_paid_gmt && documentTotalsToTheOrder && !hasStoreCredit/)
  assert.match(body, /totalsToTheOrder: documentTotalsToTheOrder && !hasStoreCredit/)
  assert.match(body, /action: STORE_CREDIT_INVOICE_WITHHELD_ACTION/)
})

// ---------------------------------------------------------------------------------------------------
// The reconciliation tolerance must not grow with the number of lines (Codex round 1, HIGH).
// ---------------------------------------------------------------------------------------------------

test('MANY LINES: a GBP 1 credit already reduced into 201 lines and subtracted again is REFUSED', () => {
  // Lines already carry the credit (goods 199.00 + VAT 39.80 = 238.80, which IS the Woo total). Counting the
  // 1.00 credit as a payment as well expects 237.80 against 238.80. A tolerance of half a penny per line
  // (201 lines + shipping = 1.01) used to wave this through.
  const result = checkWcStoreCreditReconciles({
    subtotalForeign: toDecimal(199), taxForeign: toDecimal(39.8), shippingForeign: toDecimal(0),
    orderLevelDiscountForeign: toDecimal(0), storeCreditForeign: toDecimal(1), orderTotalForeign: toDecimal(238.8),
    currency: 'GBP', componentCount: 202,
  })
  precondition('201 lines, credit inside the lines', { components: 202, difference: result.ok ? 0 : num(result.difference), tolerance: result.ok ? null : num(result.tolerance) })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && num(result.difference), -1)
  assert.equal(result.ok === false && num(result.tolerance), 0.02, 'the allowance is capped at two minor units however many lines there are')
})

test('MANY LINES: an honest 201-line credit order that is a penny out from rounding is accepted', () => {
  const result = checkWcStoreCreditReconciles({
    subtotalForeign: toDecimal(200), taxForeign: toDecimal(40), shippingForeign: toDecimal(0),
    orderLevelDiscountForeign: toDecimal(0), storeCreditForeign: toDecimal(1), orderTotalForeign: toDecimal(239.01),
    currency: 'GBP', componentCount: 202,
  })
  precondition('201 lines, honest, 0.01 out', { components: 202, difference: -0.01 })
  assert.deepEqual(result, { ok: true })
})
