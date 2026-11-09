import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeWcRateMoneyRefusal,
  findWcRateMoneyProblems,
  wcRatesThatMovedMoney,
  type WcRateResolution,
} from '@/lib/domain/accounting/wc-rate-money-refusal'
import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

/** An unmapped or inactive tax rate that moved money refuses; one that moved nothing does not. */

type Slice = Pick<WcFullOrder, 'line_items' | 'shipping_lines' | 'fee_lines' | 'tax_lines'>

const item = (name: string, total: string, taxes: Array<{ id: number; total: string; subtotal?: string }>, subtotal = total) =>
  ({ id: 1, name, product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal, subtotal_tax: '0', total, total_tax: '0', taxes: taxes.map((t) => ({ ...t, subtotal: t.subtotal ?? t.total })), meta_data: [], sku: 'S', price: 1 }) as WcFullOrder['line_items'][number]
const order = (over: Partial<Slice> = {}): Slice => ({ line_items: [], shipping_lines: [], fee_lines: [], tax_lines: [], ...over })
const mapped = (name: string, active = true): WcRateResolution => ({ source: 'mapped', taxRateName: name, active })

test('an unmapped rate id that carried tax is a problem, however the resolver substituted for it', () => {
  const resolved = new Map<number, WcRateResolution>([[220, { source: 'default', taxRateName: 'GB VAT', active: true }]])
  const problems = findWcRateMoneyProblems(order({ line_items: [item('Widget', '100.00', [{ id: 220, total: '19.00' }])] }), resolved)
  assert.deepEqual(problems, [{ wcRateId: 220, kind: 'unmapped', where: ['line item "Widget"'], taxRateName: null }])
})

test('an unmapped rate on a net amount with ZERO tax is still a problem (a 0% fallback would otherwise pass)', () => {
  const problems = findWcRateMoneyProblems(order({ line_items: [item('Widget', '100.00', [{ id: 301, total: '0.00' }])] }), new Map([[301, { source: 'default' as const }]]))
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'unmapped')
})

test('an id the importer never resolved is treated as unmapped', () => {
  const problems = findWcRateMoneyProblems(order({ tax_lines: [{ id: 1, rate_code: 'X', rate_id: 77, label: 'X', compound: false, tax_total: '1.00', shipping_tax_total: '0' }] }), new Map())
  assert.deepEqual(problems.map((p) => [p.wcRateId, p.kind, p.where]), [[77, 'unmapped', ['tax_lines']]])
})

test('a mapping to an INACTIVE rate is a problem, named, on line items, shipping and fees', () => {
  const resolved = new Map<number, WcRateResolution>([[150, mapped('Zero Rated VAT', false)]])
  const problems = findWcRateMoneyProblems(order({
    line_items: [item('Widget', '10.00', [{ id: 150, total: '0.00' }])],
    shipping_lines: [{ id: 2, method_title: 'Post', method_id: 'flat', total: '4.00', total_tax: '0', taxes: [{ id: 150, total: '0.00' }] }],
    fee_lines: [{ id: 3, name: 'EU Duty', total: '3.00', total_tax: '0', taxes: [{ id: 150, total: '0.00' }] }],
  }), resolved)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'inactive')
  assert.equal(problems[0].taxRateName, 'Zero Rated VAT')
  assert.deepEqual(problems[0].where, ['line item "Widget"', 'shipping', 'fee "EU Duty"'])
  const text = describeWcRateMoneyRefusal('1001', problems)
  assert.match(text!, /rate 150 .* is mapped to the IMS tax rate "Zero Rated VAT", which is INACTIVE/)
  assert.match(text!, /Order 1001/)
})

test('rate 182 ("Taxes & Duties") with money on it, unmapped or inactive, is refused', () => {
  const o = order({ fee_lines: [{ id: 3, name: 'Taxes & Duties', total: '12.00', total_tax: '0', taxes: [{ id: 182, total: '0.00' }] }], tax_lines: [{ id: 9, rate_code: 'TD', rate_id: 182, label: 'Taxes & Duties', compound: false, tax_total: '2.10', shipping_tax_total: '0' }] })
  assert.equal(findWcRateMoneyProblems(o, new Map())[0].kind, 'unmapped')
  assert.equal(findWcRateMoneyProblems(o, new Map([[182, mapped('Taxes & Duties', false)]]))[0].kind, 'inactive')
  assert.deepEqual(findWcRateMoneyProblems(o, new Map([[182, mapped('Taxes & Duties')]])), [], 'mapped and active is the reconciliation\'s business, not this check\'s')
})

test('a rate named only on zero-value lines moved nothing and is not refused', () => {
  const o = order({
    line_items: [item('Free sample', '0.00', [{ id: 400, total: '0.00' }])],
    tax_lines: [{ id: 1, rate_code: 'Z', rate_id: 400, label: 'Z', compound: false, tax_total: '0.00', shipping_tax_total: '0.00' }],
  })
  assert.deepEqual(wcRatesThatMovedMoney(o), [])
  assert.deepEqual(findWcRateMoneyProblems(o, new Map()), [])
})

test('mapped and active, and only an explicit false counts as inactive', () => {
  const o = order({ line_items: [item('Widget', '100.00', [{ id: 220, total: '19.00' }])] })
  assert.deepEqual(findWcRateMoneyProblems(o, new Map([[220, mapped('DE VAT')]])), [])
  assert.deepEqual(findWcRateMoneyProblems(o, new Map([[220, { source: 'mapped' as const, taxRateName: 'DE VAT' }]])), [])
  assert.equal(describeWcRateMoneyRefusal('1', []), null)
})

test('the importer is wired to refuse: the document is stamped, no payment registered, and the resolver reports `active`', async () => {
  const { readFileSync } = await import('node:fs')
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const importer = strip(readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8'))
  assert.match(importer, /findWcRateMoneyProblems\(wcOrder, wcResolvedById\)/)
  assert.match(importer, /documentTotalsToTheOrder = shippingTax\.resolved && documentTaxReconciliation\.reconciles && rateMoneyRefusal === null/)
  const mapping = strip(readFileSync('lib/connectors/woocommerce/sync/field-mapping.ts', 'utf8'))
  assert.match(mapping, /active: mapping\.taxRate\.active/)
  assert.match(mapping, /reverseCharge: true, active: true \}/)
  assert.match(importer, /noTaxKind: 'fee-no-tax' as const/)
})

// Each source of "money" is sufficient ON ITS OWN: the rate is refused when only that one figure is non-zero.
const NO_MAP = new Map<number, WcRateResolution>()
const ids = (o: Slice) => findWcRateMoneyProblems(o, NO_MAP).map((p) => p.wcRateId)

test('a line item moved money by its net alone, its pre-discount subtotal alone, its tax alone, or its pre-discount tax alone', () => {
  assert.deepEqual(ids(order({ line_items: [item('A', '10.00', [{ id: 11, total: '0', subtotal: '0' }], '0')] })), [11], 'net (total) alone')
  assert.deepEqual(ids(order({ line_items: [item('A', '0', [{ id: 12, total: '0', subtotal: '0' }], '10.00')] })), [12], 'subtotal alone (a 100% coupon line)')
  assert.deepEqual(ids(order({ line_items: [item('A', '0', [{ id: 13, total: '2.00', subtotal: '0' }], '0')] })), [13], 'tax total alone')
  assert.deepEqual(ids(order({ line_items: [item('A', '0', [{ id: 14, total: '0', subtotal: '2.00' }], '0')] })), [14], 'tax subtotal alone')
  assert.deepEqual(ids(order({ line_items: [item('A', '0', [{ id: 15, total: '0', subtotal: '0' }], '0')] })), [], 'and nothing at all moves nothing')
})

test('shipping and a fee moved money by net alone and by tax alone', () => {
  const ship = (id: number, total: string, tax: string) => ({ id: 2, method_title: 'P', method_id: 'f', total, total_tax: '0', taxes: [{ id, total: tax }] })
  const fee = (id: number, total: string, tax: string) => ({ id: 3, name: 'F', total, total_tax: '0', taxes: [{ id, total: tax }] })
  assert.deepEqual(ids(order({ shipping_lines: [ship(21, '4.00', '0')] })), [21])
  assert.deepEqual(ids(order({ shipping_lines: [ship(22, '0', '0.80')] })), [22], 'shipping tax alone')
  assert.deepEqual(ids(order({ fee_lines: [fee(23, '3.00', '0')] })), [23])
  assert.deepEqual(ids(order({ fee_lines: [fee(24, '0', '0.60')] })), [24], 'fee tax alone')
  assert.deepEqual(ids(order({ shipping_lines: [ship(25, '0', '0')], fee_lines: [fee(26, '0', '0')] })), [])
})

test('tax_lines moved money by cart tax alone and by shipping tax alone', () => {
  const tl = (rate_id: number, tax_total: string, shipping_tax_total: string) => ({ id: 1, rate_code: 'X', rate_id, label: 'X', compound: false, tax_total, shipping_tax_total })
  assert.deepEqual(ids(order({ tax_lines: [tl(31, '1.00', '0')] })), [31])
  assert.deepEqual(ids(order({ tax_lines: [tl(32, '0', '1.00')] })), [32], 'shipping tax alone')
  assert.deepEqual(ids(order({ tax_lines: [tl(33, '0', '0')] })), [])
})
