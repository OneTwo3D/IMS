import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSalesOrderWriteModel } from '@/lib/domain/sales/sales-order-write-model'
import { invoiceDiscountParts, parseDiscountTaxSplit } from '@/lib/domain/sales/discount-tax-split'
import { planSplitDiscountReversal } from '@/lib/domain/sales/discount-tax-split-plan'
import { expectedLedgerTotal, invoiceReconciliationProblem } from '@/lib/domain/sales/sales-invoice-reconciliation'
import { findSalesDocumentTaxTypeProblems } from '@/lib/domain/accounting/sales-document-tax-types'
import { orderDiscountReversal } from '@/lib/domain/sales/refund-line-net'
import { buildRefundRequest, creditAmounts } from '@/lib/domain/sales/sales-order-money-view'
import { buildSalesInvoicePayload } from '@/lib/connectors/xero/invoices'
import { Prisma } from '@/app/generated/prisma/client'
import { addShippingOrder } from '@/lib/domain/finance/finance-period-analytics'

/**
 * THE ORDER DISCOUNT TAXED AT ITS LINES' RATES, END TO END (sales_order_discount_tax_apportion_enabled ON): one 20% / 5% / 0% order with a discount, each consumer of the order agrees with the tax the order stores.
 * [mutation: tax a part at the header code, drop the split from the reconciliation, reverse the discount at one rate, or leave the discount VAT in the shipping residual: red]
 */

const RATES = { A: 0.2, B: 0.05, C: 0 } as const
const lines = (['A', 'B', 'C'] as const).map((id) => ({
  input: { productId: `p${id}`, sku: `S-${id}`, description: id, qty: 1, unitPriceForeign: 100 },
  rate: RATES[id], taxRateId: id, accountingTaxType: `OUT-${id}`, reverseCharge: false,
}))
const build = (discount: number, extra: Record<string, unknown> = {}) => buildSalesOrderWriteModel({ fxRate: 1, vatRate: 0.2, pricesIncludeVat: false, shippingForeign: 10, orderDiscountForeign: discount, apportionDiscountTax: true, lines, ...extra })

test('a 60 discount over 20% / 5% / 0% lines takes 20 of net from each and 4 + 1 + 0 of VAT; the order stores that split', () => {
  const m = build(60)
  assert.equal(m.totals.taxForeign, 25 + 2 - 5)
  const split = m.discountTaxSplit!
  assert.deepEqual(split.map((e) => [e.taxRateId, e.netForeign, e.taxForeign, e.netBase, e.taxBase]), [['A', 20, 4, 20, 4], ['B', 20, 1, 20, 1], ['C', 20, 0, 20, 0]])
  assert.deepEqual(parseDiscountTaxSplit(JSON.parse(JSON.stringify(split))), split, 'it survives the JSON column')
})

test('the capped discount (far above the goods) leaves the header tax at the shipping VAT, never negative (the 20/5/0 golden shape)', () => {
  const m = build(100000)
  assert.equal(m.totals.discountAmount, 300)
  assert.equal(m.totals.taxForeign, 2)
  assert.ok(m.totals.taxForeign >= 0)
  assert.equal(m.discountTaxSplit!.reduce((s, e) => s + e.taxForeign, 0), 25)
})

test('flag OFF: no split is produced and the model carries no discountTaxSplit key at all (byte-identical to the header-rate write)', () => {
  const m = buildSalesOrderWriteModel({ fxRate: 1, vatRate: 0.2, pricesIncludeVat: false, shippingForeign: 10, orderDiscountForeign: 60, lines })
  assert.ok(!('discountTaxSplit' in m))
  assert.equal(m.totals.taxForeign, 25 + 2 - 12, 'header-rate: the whole discount at 20%')
})

// --- the Xero invoice and the reconciliation ---------------------------------------------------

const invoiceOf = (discount: number, withParts: boolean) => {
  const m = build(discount)
  const total = m.totals.totalForeign
  const parts = invoiceDiscountParts({ split: m.discountTaxSplit!, lineAmountsIncludeTax: false, totalAmount: m.totals.discountAmount, taxTypeOf: (e) => e.accountingTaxType })!
  const doc = {
    lineAmountsIncludeTax: false, headerRate: 0.2,
    lines: [0.2, 0.05, 0].map((rate) => ({ quantity: 1, unitAmount: 100, rate, storedTax: 0 })),
    shippingAmount: 10, shippingRate: 0.2, discountAmount: m.totals.discountAmount, discountRate: 0.2,
    ...(withParts ? { discountParts: parts.map((p) => ({ amount: p.amount, rate: RATES[p.taxRateId as 'A' | 'B' | 'C'] })) } : {}),
  }
  return { total, parts, doc }
}

test('reconciliation: with the parts the invoice totals the order exactly; the single header-rate line would be refused (7 out)', () => {
  const { total, parts, doc } = invoiceOf(60, true)
  assert.deepEqual(parts.map((p) => [p.taxType, p.amount]), [['OUT-A', 20], ['OUT-B', 20], ['OUT-C', 20]])
  assert.equal(Math.round(expectedLedgerTotal(doc) * 100) / 100, total)
  assert.equal(invoiceReconciliationProblem(doc, total), null)
  const { discountParts: _dropped, ...single } = doc
  void _dropped
  const problem = invoiceReconciliationProblem(single, total)
  assert.ok(problem, 'without the parts the ledger would book the discount VAT at 20% and be 7 out')
  assert.equal(problem!.difference, -7)
})

test('reconciliation: the capped discount (300) reconciles per rate as well', () => {
  const { total, doc } = invoiceOf(100000, true)
  assert.equal(doc.discountAmount, 300)
  assert.equal(invoiceReconciliationProblem(doc, total), null)
})

test('an inclusive document sends each part gross (net + its own VAT) and the parts add up to the discount sent', () => {
  const m = buildSalesOrderWriteModel({ fxRate: 1, vatRate: 0.2, pricesIncludeVat: true, shippingForeign: 12, orderDiscountForeign: 22, apportionDiscountTax: true,
    lines: lines.slice(0, 1).concat(lines.slice(2)).map((l) => ({ ...l, input: { ...l.input, unitPriceForeign: l.rate > 0 ? 120 : 100 } })) })
  const parts = invoiceDiscountParts({ split: m.discountTaxSplit!, lineAmountsIncludeTax: true, totalAmount: 22, taxTypeOf: (e) => e.accountingTaxType })!
  assert.deepEqual(parts.map((p) => [p.taxType, p.amount]), [['OUT-A', 12], ['OUT-C', 10]])
  assert.equal(parts.reduce((s, p) => s + p.amount, 0), 22)
})

test('the Xero builder posts one discount line per code on the discount account, and the lines\' VAT per rate is the order\'s', () => {
  const { parts } = invoiceOf(60, true)
  const payload = buildSalesInvoicePayload({
    invoiceNumber: 'INV-1', contactName: 'c', date: '2026-11-20', currency: 'GBP',
    lines: [0.2, 0.05, 0].map((_r, i) => ({ description: `l${i}`, quantity: 1, unitAmount: 100, accountCode: '200', taxType: ['OUT-A', 'OUT-B', 'OUT-C'][i] })),
    shippingAmount: 10, shippingAccountCode: '260', shippingTaxType: 'OUT-A',
    discountAmount: 60, discountAccountCode: '270', discountTaxType: 'OUT-A',
    discountParts: parts.map((p) => ({ amount: p.amount, taxType: p.taxType ?? undefined })),
  }, 'DRAFT', 'contact-1', new Set(), 'GBP') as { LineItems: Array<{ AccountCode: string; TaxType: string; UnitAmount: number; Description: string }> }
  const discountLines = payload.LineItems.filter((l) => l.AccountCode === '270')
  assert.deepEqual(discountLines.map((l) => [l.TaxType, l.UnitAmount]), [['OUT-A', -20], ['OUT-B', -20], ['OUT-C', -20]])
  const vatByCode = new Map<string, number>()
  for (const l of payload.LineItems) vatByCode.set(l.TaxType, (vatByCode.get(l.TaxType) ?? 0) + l.UnitAmount * ({ 'OUT-A': 0.2, 'OUT-B': 0.05, 'OUT-C': 0 }[l.TaxType] ?? 0))
  assert.deepEqual([...vatByCode].map(([k, v]) => [k, Math.round(v * 100) / 100]), [['OUT-A', 20 + 2 - 4], ['OUT-B', 5 - 1], ['OUT-C', 0]])
})

test('without parts the builder still posts the single header-code line (the flag-off payload)', () => {
  const payload = buildSalesInvoicePayload({
    invoiceNumber: 'INV-1', contactName: 'c', date: '2026-11-20', currency: 'GBP',
    lines: [{ description: 'l', quantity: 1, unitAmount: 100, accountCode: '200', taxType: 'OUT-A' }],
    discountAmount: 10, discountAccountCode: '270', discountTaxType: 'OUT-A',
  }, 'DRAFT', 'contact-1', new Set(), 'GBP') as { LineItems: Array<{ AccountCode: string; TaxType: string; UnitAmount: number }> }
  assert.deepEqual(payload.LineItems.filter((l) => l.AccountCode === '270').map((l) => [l.TaxType, l.UnitAmount]), [['OUT-A', -10]])
})

test('parts that do not add up to the discount, or one without a code, are refused rather than sent', () => {
  const base = { lines: [{ taxType: 'OUT-A' }], discountAmount: 60, discountAccountCode: '270', discountTaxType: 'OUT-A' }
  assert.deepEqual(findSalesDocumentTaxTypeProblems({ ...base, discountParts: [{ amount: 20, taxType: 'A' }, { amount: 30, taxType: 'B' }] }).map((p) => p.kind), ['inconsistent'])
  assert.deepEqual(findSalesDocumentTaxTypeProblems({ ...base, discountParts: [{ amount: 30, taxType: 'A' }, { amount: 30 }] }).map((p) => p.kind), ['missing'])
  assert.deepEqual(findSalesDocumentTaxTypeProblems({ ...base, discountParts: [{ amount: 30, taxType: 'A' }, { amount: 30, taxType: 'B' }] }), [])
})

// --- the refund ---------------------------------------------------------------------------------

const orderLines = (['A', 'B', 'C'] as const).map((id) => ({ id: `L${id}`, taxRateId: id, totalForeign: 100 }))
const plan = (refunded: Record<string, number>, prior: Parameters<typeof planSplitDiscountReversal>[0]['prior'] = []) => planSplitDiscountReversal({
  split: build(60).discountTaxSplit!, lines: orderLines, refundedNetByLine: new Map(Object.entries(refunded)), prior, fxRateToBase: 1, minorUnits: 2,
  reversal: (r) => orderDiscountReversal({ discountAmount: r.discountNet, amountsIncludeVat: false, vatRate: 0, orderSaleNet: r.orderSaleNet, priorSaleNet: r.priorSaleNet, priorDiscountForeign: r.priorDiscountForeign, priorDiscountBase: r.priorDiscountBase, refundedSaleNet: r.refundedSaleNet, fxRateToBase: 1, minorUnits: 2 }),
})

test('refund of the 5% line only: its own 20 of discount comes back at 5% (1 of VAT), the 20% and 0% shares are untouched', () => {
  const p = plan({ LB: 100 })
  assert.deepEqual(p.map((x) => [x.entry.taxRateId, x.foreign, x.entry.rate]), [['B', 20, 0.05]])
  const credit = creditAmounts(100, 0.05)
  const discount = creditAmounts(p[0]!.foreign, p[0]!.entry.rate)
  assert.equal(Math.round((credit.vat - discount.vat) * 100) / 100, 4, 'VAT credited for the 5% line: 5 less the 1 of its discount')
})

test('full refund: every rate\'s share comes back in full, so the discount VAT credited is exactly the 5 the order took off', () => {
  const p = plan({ LA: 100, LB: 100, LC: 100 })
  assert.deepEqual(p.map((x) => x.foreign), [20, 20, 20])
  assert.equal(p.reduce((s, x) => s + creditAmounts(x.foreign, x.entry.rate).vat, 0), 5)
})

test('a second refund takes only what the first left of each rate\'s share (a half, then the rest)', () => {
  const first = plan({ LA: 50 })
  assert.deepEqual(first.map((x) => x.foreign), [10])
  const prior = [
    { lineKind: 'sale', salesOrderLineId: 'LA', discountTaxRateId: null, totalForeign: 50, totalBase: 50 },
    { lineKind: 'discount', salesOrderLineId: null, discountTaxRateId: 'A', totalForeign: -10, totalBase: -10 },
  ]
  const second = plan({ LA: 50 }, prior)
  assert.deepEqual(second.map((x) => x.foreign), [10], 'completing the 20% lines takes exactly the remaining 10, not a re-cut of 20')
})

test('the refund dialog preview is the same per-rate cut the server writes', () => {
  const split = build(60).discountTaxSplit!
  const preview = buildRefundRequest({
    taxRatePercent: 0.2, fxRateToBase: 1, discount: { amount: 60, amountsIncludeVat: false, split },
    lines: orderLines.map((l) => ({ ...l, qty: 1, unitPriceForeign: 100, discountAmount: 0, taxForeign: 100 * RATES[l.taxRateId], productId: null, description: l.id, totalBase: 100, taxRatePercent: RATES[l.taxRateId] })),
  }, [{ lineId: 'LB', qty: 1 }])
  assert.deepEqual(preview.discountReversal, { net: -20, vat: -1, gross: -21 })
  assert.equal(preview.total.vat, 4)
})

// --- the VAT report -----------------------------------------------------------------------------

test('VAT report residual: an order that apportioned its discount shows the shipping VAT alone on the order-level row; a header-rate order keeps the discount VAT in it', () => {
  const m = build(60)
  const split = m.discountTaxSplit!
  const row = (discountTaxSplit: unknown) => ({ shippingBase: 10, taxBase: m.totals.taxBase, shippingAddress: { country: 'GB' }, lines: [{ taxBase: 20 }, { taxBase: 5 }, { taxBase: 0 }], discountTaxSplit })
  const fresh = () => ({ byJurisdiction: new Map<string, { orders: number; shipping: Prisma.Decimal; tax: Prisma.Decimal }>(), negativeOrders: 0, negativeTax: new Prisma.Decimal(0) })
  const a = fresh(); addShippingOrder(a, row(split))
  const b = fresh(); addShippingOrder(b, row(null))
  assert.equal(String([...a.byJurisdiction.values()][0]!.tax), '2', 'shipping VAT 2')
  assert.equal(String([...b.byJurisdiction.values()][0]!.tax), '-3', 'header-rate treatment: shipping 2 less the 5 of discount VAT')
})

test('a split that disagrees with the discount by more than rounding is refused (null), not absorbed by the largest rate; a penny of rounding still is', () => {
  const split = build(60).discountTaxSplit!
  const run = (totalAmount: number) => invoiceDiscountParts({ split, lineAmountsIncludeTax: false, totalAmount, taxTypeOf: (e) => e.accountingTaxType })
  assert.equal(run(65), null, 'a stale split 5 short of the discount')
  assert.deepEqual(run(60.01)!.map((p) => p.amount), [20.01, 20, 20], 'a rounding penny lands on the largest part')
})

// ---- the tax code of a group of the split: one derivation for the invoice, the refund and the save refusal ----------------------------------------

test('discountSplitEntryTaxType: the group\'s own code, else the order default code, then the reverse-charge swap; null when neither gives one', async () => {
  const { discountSplitEntryTaxType } = await import('@/lib/domain/sales/discount-tax-split')
  const ctx = { orderDefaultTaxType: 'DEFCODE', reverseChargeSalesTaxType: 'RCSALES' }
  assert.equal(discountSplitEntryTaxType({ accountingTaxType: 'OWN', reverseCharge: false }, ctx), 'OWN')
  assert.equal(discountSplitEntryTaxType({ accountingTaxType: null, reverseCharge: false }, ctx), 'DEFCODE', 'a group with no code of its own takes the order default code, as the goods line does')
  assert.equal(discountSplitEntryTaxType({ accountingTaxType: 'OWN', reverseCharge: true }, ctx), 'RCSALES')
  assert.equal(discountSplitEntryTaxType({ accountingTaxType: 'OWN', reverseCharge: true }, { ...ctx, reverseChargeSalesTaxType: '' }), 'OWN')
  assert.equal(discountSplitEntryTaxType({ accountingTaxType: null, reverseCharge: false }, { orderDefaultTaxType: null, reverseChargeSalesTaxType: '' }), null)
})

test('discountSplitTaxCodeRefusal: refuses a split with a group that has no code, naming the group and its rate; null when every group has one or there is no split', async () => {
  const { discountSplitTaxCodeRefusal } = await import('@/lib/domain/sales/discount-tax-split')
  const e = (taxRateId: string | null, accountingTaxType: string | null, rate: number) => ({ taxRateId, accountingTaxType, reverseCharge: false, rate, netForeign: 10, taxForeign: 10 * rate, netBase: 10, taxBase: 10 * rate })
  const none = { orderDefaultTaxType: null, reverseChargeSalesTaxType: '' }
  assert.equal(discountSplitTaxCodeRefusal(null, none), null)
  assert.equal(discountSplitTaxCodeRefusal([e('r20', 'OUTPUT2', 0.2)], none), null)
  const refused = discountSplitTaxCodeRefusal([e('r20', 'OUTPUT2', 0.2), e(null, null, 0.2)], none, 'live-save')
  assert.match(refused ?? '', /the lines with no tax rate \(20%\) have no accounting tax code/, 'the no-rate group is at the header rate, here 20%, not 0%')
  // The same group with an order default code is posted on it, so nothing is refused.
  assert.equal(discountSplitTaxCodeRefusal([e('r20', 'OUTPUT2', 0.2), e(null, null, 0.2)], { orderDefaultTaxType: 'OUTPUT2', reverseChargeSalesTaxType: '' }), null)
  assert.match(discountSplitTaxCodeRefusal([e('rX', null, 0.05)], none) ?? '', /the lines at 5% have no accounting tax code/)
})

// [mutation: the isNoTaxType check removed]
test('discountSplitTaxCodeRefusal: an EXPLICIT NONE code (any case, padded) is no code, on the group\'s own code and on the order default alike; the reverse-charge swap onto a real code clears it', async () => {
  const { discountSplitTaxCodeRefusal } = await import('@/lib/domain/sales/discount-tax-split')
  const e = (accountingTaxType: string | null, reverseCharge = false) => ({ taxRateId: 'rN', accountingTaxType, reverseCharge, rate: 0, netForeign: 10, taxForeign: 0, netBase: 10, taxBase: 0 })
  const none = { orderDefaultTaxType: null, reverseChargeSalesTaxType: '' }
  for (const code of ['NONE', 'none', ' None ']) assert.match(discountSplitTaxCodeRefusal([e(code)], none) ?? '', /the lines at 0% have no accounting tax code/, code)
  assert.match(discountSplitTaxCodeRefusal([{ ...e(null), taxRateId: null }], { orderDefaultTaxType: 'NONE', reverseChargeSalesTaxType: '' }) ?? '', /the lines with no tax rate \(0%\)/, 'a no-rate group on an order default NONE')
  assert.equal(discountSplitTaxCodeRefusal([e('NONE', true)], { orderDefaultTaxType: null, reverseChargeSalesTaxType: 'ECZROUTPUTSERVICES' }), null)
})

// [mutation: the per-context ending removed / swapped]
test('discountSplitTaxCodeRefusal: the ending belongs to where the message is shown (a live save may fall back to a draft, a finalisation says to map the rate, the invoice build adds its own)', async () => {
  const { discountSplitTaxCodeRefusal } = await import('@/lib/domain/sales/discount-tax-split')
  const split = [{ taxRateId: 'rX', accountingTaxType: null, reverseCharge: false, rate: 0.2, netForeign: 10, taxForeign: 2, netBase: 10, taxBase: 2 }]
  const none = { orderDefaultTaxType: null, reverseChargeSalesTaxType: '' }
  const problem = 'The order discount is taxed per line rate, but the lines at 20% have no accounting tax code, so the invoice could not post their share of the discount (or the lines) and would be refused when it is sent.'
  assert.equal(discountSplitTaxCodeRefusal(split, none, 'invoice'), problem)
  assert.equal(discountSplitTaxCodeRefusal(split, none), problem, 'the default is the bare statement')
  const live = discountSplitTaxCodeRefusal(split, none, 'live-save')!
  assert.ok(live.startsWith(problem) && live.endsWith('and try again. A draft can still be saved.'), live)
  const finalise = discountSplitTaxCodeRefusal(split, none, 'finalise')!
  assert.ok(finalise.startsWith(problem) && finalise.endsWith('then finalise it again.'), finalise)
  assert.doesNotMatch(finalise, /A draft can still be saved/, 'a finalisation is of a draft already')
})

// [mutation: the refresh removed or applied to the no-rate group]
test('refreshDiscountSplitCodes: a group\'s code is its rate\'s code now (mapped, unmapped, or changed); a rate the map does not know and a no-rate group keep what they hold', async () => {
  const { refreshDiscountSplitCodes } = await import('@/lib/domain/sales/discount-tax-split')
  const e = (taxRateId: string | null, accountingTaxType: string | null) => ({ taxRateId, accountingTaxType, reverseCharge: false, rate: 0.2, netForeign: 10, taxForeign: 2, netBase: 10, taxBase: 2 })
  const split = [e('mapped-since', null), e('unmapped-since', 'OLD'), e('changed', 'OLD'), e('unknown', 'KEEP'), e(null, 'NORATE')]
  const out = refreshDiscountSplitCodes(split, new Map<string, string | null>([['mapped-since', 'OUTPUT2'], ['unmapped-since', null], ['changed', 'NEW']]))
  assert.deepEqual(out.map((x) => x.accountingTaxType), ['OUTPUT2', null, 'NEW', 'KEEP', 'NORATE'])
  assert.equal(split[0]!.accountingTaxType, null, 'the stored entries are not mutated')
})

test('the invoice\'s discount parts, the refund\'s per-rate reversal and the save / finalise refusal all derive a group\'s code through discountSplitEntryTaxType, from the split refreshed from its rates', async () => {
  const { readFileSync } = await import('node:fs')
  const sales = readFileSync('app/actions/sales.ts', 'utf8')
  assert.match(sales, /taxTypeOf: \(entry\) => postedDiscountTaxType\(posted, entry, orderDefaultRate\?\.id \?\? null\) \?\? discountSplitEntryTaxType\(entry, \{ orderDefaultTaxType, reverseChargeSalesTaxType: settings\.reverseChargeSalesTaxType \}\)/, 'an update of a posted invoice keeps the part\'s posted code, else the one derivation')
  assert.match(sales, /const discountSplit = storedDiscountSplit \? await refreshedDiscountSplit\(reader, storedDiscountSplit\) : null/, 'the invoice reads the codes from the rates now')
  assert.match(sales, /discountSplitTaxCodeRefusal\(discountSplit\.filter\(\(entry\) => postedDiscountTaxType\(posted, entry, orderDefaultRate\?\.id \?\? null\) === null\), \{ orderDefaultTaxType, reverseChargeSalesTaxType: settings\.reverseChargeSalesTaxType \}, 'invoice'\)/, 'the invoice build backstop')
  assert.match(sales, /discountSplitTaxCodeRefusal\(await refreshedDiscountSplit\(reader, split\)/, 'the finalisation check reads the codes from the rates now')
  assert.match(sales, /prepareSalesOrderWrite\(input, \{ liveOrder: !input\.isDraft \}\)/, 'create: live orders only')
  assert.match(sales, /liveOrder: true \} : undefined\)/, 'edit: confirmed orders only')
  assert.match(sales, /const splitCodeRefusal = await discountSplitTaxCodeRefusalFor\(db, so, 'finalise'\)/, 'draft finalisation')
  assert.match(sales, /if \(!syncEnabled\) return null/, 'no refusal while accounting sync is off (no invoice is queued)')
  const refund = readFileSync('lib/domain/sales/refund-service.ts', 'utf8')
  assert.match(refund, /split: await refreshedDiscountSplit\(tx, discountSplit\)/, 'the refund reads the codes from the rates now')
  assert.match(refund, /accountingTaxType: postedDiscountTaxType\(postedInvoiceCodes, part\.entry\)\s*\?\? discountSplitEntryTaxType\(part\.entry, \{ orderDefaultTaxType,/, 'a posted invoice\'s discount part is reversed on the code it posted with; otherwise the one derivation')
  assert.equal((refund.match(/where: \{ name: so\.taxRateName, active: true \}/g) ?? []).length, 1, 'the order default rate is looked up once in the refund')
  assert.doesNotMatch(refund, /baseTaxType: part\.entry\.accountingTaxType \?\? null/, 'the refund no longer drops the order default fallback')
})
