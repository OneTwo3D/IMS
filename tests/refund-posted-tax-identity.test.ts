import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTaxTypeRateIndex,
  chargedRateFromLineSnapshot,
  chargedRateFromShippingSnapshot,
  chargedShippingMoney,
  postedCreditNoteAggregateCheck,
  postedCreditNoteTotalCheck,
  priceRefundTaxIdentity,
  resolveOrderUniformTaxIdentity,
  resolvePostedRefundTaxIdentity,
} from '@/lib/domain/sales/refund-posted-tax-identity'
import { toDecimal } from '@/lib/domain/math/decimal'

/**
 * o3d-w00 (Codex r4 #1 / #3): the two rates this module has to keep apart.
 *
 *   POSTED  — what the accounting tax code the credit note carries is worth TODAY. Read from the tax
 *             table, because that is what the connector will re-gross the net line by.
 *   CHARGED — what this part of the order was billed at WHEN IT WAS SOLD. A historical fact, and the
 *             tax table is not a record of it: a TaxRate row is mutable, and an admin editing one
 *             rewrites what every past order appears to have been charged.
 *
 * The r3 divergence check read both from the tax table, so it compared today's rate against today's
 * rate and could never disagree. These pin the charged side to the order's own money.
 */

/** £10.00 net with £2.00 of VAT on it: this line was sold at 20%, whatever the tax table says now. */
const CHARGED_20 = { currency: 'GBP', netForeign: 10, taxForeign: 2 }
/** £20.00 net with no VAT: sold zero-rated. */
const CHARGED_0 = { currency: 'GBP', netForeign: 20, taxForeign: 0 }

/**
 * Codex r5 #1: what the ORDER records about its SHIPPING leg. IMS has no shipping-VAT column, so the
 * VAT half is the money the order carries over and above its lines.
 *
 * Both of these orders have a 20% HEADER rate — the goods are standard-rated, £100 net bearing £20 of
 * VAT — and each is deliberately built so shipping's OWN rate is a different number, because that is
 * the only shape in which the header default and the shipping leg can be told apart. A fixture where
 * they are the same number proves nothing.
 */
/** £10 of postage carrying NO VAT (zero-rated delivery) on 20% goods: order VAT 20.00 is all the line's. */
const SHIPPING_CHARGED_0 = {
  currency: 'GBP',
  netForeign: 10,
  orderTaxForeign: 20,
  lineTaxForeign: [20],
  orderDiscountAmount: 0,
}
/** £10 of postage carrying £2.00 of VAT on ZERO-rated goods: every penny of the order's VAT is shipping's. */
const SHIPPING_CHARGED_20 = {
  currency: 'GBP',
  netForeign: 10,
  orderTaxForeign: 2,
  lineTaxForeign: [0],
  orderDiscountAmount: 0,
}

const index = (rows: Array<{ accountingTaxType: string | null; rate: number }>) => buildTaxTypeRateIndex(rows)

test('the charged rate is read off the order line, never off the tax table (o3d-w00 Codex r4 #1)', () => {
  // The line was sold at 20% under OUTPUT2. An admin has since edited that rate row down to 5%, so the
  // credit note WILL re-gross at 5% — the identity is right, the price is current, and neither is what
  // the customer paid. Converting £12 gross at 5% stores £11.43 net, and the credit note then credits
  // £11.43 of revenue and £0.57 of VAT against a sale of £10.00 + £2.00. The total settles; the VAT
  // return does not. There is no reading of the CURRENT tax table that can notice this — only the
  // order's own snapshot can.
  const identity = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    chargedLine: CHARGED_20,
    orderDefaultTaxType: 'OUTPUT2',
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.05 }]),
    label: 'Widget',
  })

  assert.equal(identity.ok, false)
  assert.match(identity.ok ? '' : identity.reason, /Widget was charged at 20% but/)
  assert.match(identity.ok ? '' : identity.reason, /accounting tax code OUTPUT2, which is 5%/)
})

test('the same line records when the tax table still prices its code at what it was sold at (o3d-w00 Codex r4 #1)', () => {
  const identity = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    chargedLine: CHARGED_20,
    orderDefaultTaxType: 'OUTPUT2',
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Widget',
  })

  assert.equal(identity.ok, true)
  assert.equal(identity.ok && identity.vatRate.toString(), '0.2')
  assert.equal(identity.ok && identity.reverseCharge, false)
})

test('a line with no money snapshot is refused, not priced from the live table (o3d-w00 Codex r4 #1)', () => {
  // Three ways the order can fail to say what it charged. None of them may fall back to the tax table:
  // absent data is not a fact, and the substitution is the whole defect.
  const resolve = (chargedLine: { netForeign?: number; taxForeign?: number } | null) =>
    resolvePostedRefundTaxIdentity({
      kind: 'sale',
      lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
      chargedLine: chargedLine && { currency: 'GBP', ...chargedLine },
      orderDefaultTaxType: 'OUTPUT2',
        rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
      label: 'Widget',
    })

  const unread = resolve({ netForeign: 10 })
  assert.equal(unread.ok, false)
  assert.match(unread.ok ? '' : unread.reason, /holds no record of the net it was sold at/)

  const noMoney = resolve({ netForeign: 0, taxForeign: 0 })
  assert.equal(noMoney.ok, false)
  assert.match(noMoney.ok ? '' : noMoney.reason, /carries no net amount \(0\.0000\)/)

  const absent = resolve(null)
  assert.equal(absent.ok, false)
  // And every one of them names something the operator can do about it.
  for (const refused of [unread, noMoney, absent]) {
    assert.match(refused.ok ? '' : refused.reason, /Allocate this refund to the parts of the order/)
  }
})

test('the derived rate is given the rounding its figures were ACTUALLY rounded at (o3d-w00 Codex r5 #2)', () => {
  const at = (chargedLine: { netForeign: number; taxForeign: number }, postedRate: number) =>
    resolvePostedRefundTaxIdentity({
      kind: 'sale',
      lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
      chargedLine: { currency: 'GBP', ...chargedLine },
      orderDefaultTaxType: 'OUTPUT2',
      rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: postedRate }]),
      label: 'Line',
    })

  // ---------------------------------------------------------------------------------------------
  // WooCommerce quantises every line's tax to the currency's minor unit before IMS ever sees it, so an
  // ordinary £4.99 line at 20% arrives carrying £1.00 of VAT rather than £0.998 and reads as 20.04%.
  // Sizing the tolerance to the Decimal(18,4) STORAGE scale made that 4.0e-4 drift twenty times too
  // wide to accept, and refused a completely ordinary imported order with no remedy the operator could
  // possibly perform. The bound belongs to where the money was rounded.
  // ---------------------------------------------------------------------------------------------
  const pennyRounded = at({ netForeign: 4.99, taxForeign: 1 }, 0.2)
  assert.equal(pennyRounded.ok, true, "a real WooCommerce 20% line: 1.00 of VAT on 4.99 reads as 20.04%")

  // A figure carrying sub-penny digits cannot have come from a penny-rounded source, and keeps the
  // tight bound: a 35p tax-inclusive line stores 0.2917 net and 0.0583 of VAT — 19.9863%, 1.37e-4 out,
  // which is inside its own 2.06e-4 storage bound and nowhere near a penny's worth of slack.
  assert.equal(at({ netForeign: 0.2917, taxForeign: 0.0583 }, 0.2).ok, true, 'a 35p tax-inclusive line')

  // ---------------------------------------------------------------------------------------------
  // THE SMALLEST LEGITIMATE LINE ACCEPTED, penny-rounded: at 20% the bound is
  // (0.005 + 0.2 x 0.005) / net, which reaches the 0.002 cap at net = 3.00 exactly.
  // ---------------------------------------------------------------------------------------------
  assert.equal(at({ netForeign: 3, taxForeign: 0.6 }, 0.2).ok, true, '£3.00 net is exactly at the cap')
  const belowTheFloor = at({ netForeign: 2.99, taxForeign: 0.6 }, 0.2)
  assert.equal(belowTheFloor.ok, false, 'a penny below it, the bound is wider than the cap')
  assert.match(belowTheFloor.ok ? '' : belowTheFloor.reason, /too small to fix the rate it was charged at/)
  // Money that really was computed at 4dp pins a line a hundred times smaller down just as well: 3.15p
  // of net carrying 0.63p of VAT is exactly 20% and is accepted, because neither figure could have been
  // rounded to the penny. The bound follows the figures, not the column they are stored in.
  assert.equal(at({ netForeign: 0.0315, taxForeign: 0.0063 }, 0.2).ok, true, '3.15p of 4dp-precision money')
  const tooSmall = at({ netForeign: 0.03, taxForeign: 0.006 }, 0.2)
  assert.equal(tooSmall.ok, false, 'a 3p line whose figures could have been penny-rounded pins nothing')
  assert.match(tooSmall.ok ? '' : tooSmall.reason, /too small to fix the rate it was charged at/)

  // ---------------------------------------------------------------------------------------------
  // THE SMALLEST MIS-SCALING STILL REJECTED. The cap is half a percentage point (5% against 5.5%, both
  // live EU rates) minus a margin, so at the very widest tolerance the check ever grants, two rates
  // that far apart still cannot both be accepted — and it is the one nearer the money that survives.
  // On £3.00 of net at 5% the tolerance is (0.005 + 0.05 x 0.005) / 3 = 0.00175.
  // ---------------------------------------------------------------------------------------------
  assert.equal(at({ netForeign: 3, taxForeign: 0.15 }, 0.05).ok, true, '5% is what the money says')
  const halfAPoint = at({ netForeign: 3, taxForeign: 0.15 }, 0.055)
  assert.equal(halfAPoint.ok, false, '5.5% on money that says 5% is 0.005 away — outside 0.00175')
  assert.match(halfAPoint.ok ? '' : halfAPoint.reason, /was charged at 5% but/)
  assert.match(halfAPoint.ok ? '' : halfAPoint.reason, /which is 5.5%/)

  // And the tolerance is not a licence at any size: a genuinely different rate on the smallest line the
  // check accepts is still caught, so widening it did not blunt the check.
  const wrongRate = at({ netForeign: 0.2917, taxForeign: 0.0583 }, 0.19)
  assert.equal(wrongRate.ok, false)
  assert.match(wrongRate.ok ? '' : wrongRate.reason, /which is 19%/)
})

test('an UNMAPPED reverse-charge code is refused, not assumed to be 0% (o3d-w00 Codex r4 #3)', () => {
  // IMS stores no rate for an accounting tax code except through a TaxRate mapping, and
  // resolveSalesLineTaxType swaps the CODE only — it knows nothing about what the code is worth. So an
  // unmapped reverse-charge code is not evidence that the credit note grosses up by nothing; it is
  // evidence that IMS cannot say. Assuming 0% converts the operator's gross as if no VAT were charged.
  const unmapped = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: true },
    chargedLine: { currency: 'GBP', netForeign: 10, taxForeign: 0 },
    orderDefaultTaxType: 'OUTPUT2',
    reverseChargeSalesTaxType: 'REVERSECHARGE',
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'RC widget',
  })

  assert.equal(unmapped.ok, false)
  assert.match(unmapped.ok ? '' : unmapped.reason, /no IMS tax rate is mapped to that code/)
  assert.match(unmapped.ok ? '' : unmapped.reason, /An unmapped code is not a 0% one/)
  // The remedy is one an admin can carry out, and it opens the same row.
  assert.match(unmapped.ok ? '' : unmapped.reason, /Map a 0% tax rate to that code in Settings → Tax Rates/)

  const mapped = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: true },
    chargedLine: { currency: 'GBP', netForeign: 10, taxForeign: 0 },
    orderDefaultTaxType: 'OUTPUT2',
    reverseChargeSalesTaxType: 'REVERSECHARGE',
    rateByTaxType: index([
      { accountingTaxType: 'OUTPUT2', rate: 0.2 },
      { accountingTaxType: 'REVERSECHARGE', rate: 0 },
    ]),
    label: 'RC widget',
  })
  assert.equal(mapped.ok, true)
  assert.equal(mapped.ok && mapped.vatRate.toString(), '0')
  assert.equal(mapped.ok && mapped.reverseCharge, true)
})

test('a reverse-charge code mapped to a VAT-bearing rate cannot be picked from (o3d-w00 Codex r3 #1)', () => {
  const identity = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: true },
    chargedLine: { currency: 'GBP', netForeign: 10, taxForeign: 0 },
    orderDefaultTaxType: 'OUTPUT2',
    reverseChargeSalesTaxType: 'REVERSECHARGE',
    rateByTaxType: index([
      { accountingTaxType: 'REVERSECHARGE', rate: 0 },
      { accountingTaxType: 'REVERSECHARGE', rate: 0.2 },
    ]),
    label: 'RC widget',
  })
  assert.equal(identity.ok, false)
  assert.match(identity.ok ? '' : identity.reason, /more than one rate \(0, 0\.2\)/)
})

test('a reverse-charge line whose money says VAT WAS charged is refused (o3d-w00 Codex r4 #1)', () => {
  // reverseCharge is a flag on a mutable TaxRate row, so it is a claim about today, not about the sale.
  // Flip it on after the fact and the r3 code would have treated the line's gross AS its net — crediting
  // £12 of revenue against a sale of £10 + £2 VAT, and never reclaiming the VAT. The line's own money
  // contradicts the flag, and the money wins.
  const identity = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: true },
    chargedLine: CHARGED_20,
    orderDefaultTaxType: 'OUTPUT2',
    reverseChargeSalesTaxType: 'REVERSECHARGE',
    rateByTaxType: index([
      { accountingTaxType: 'OUTPUT2', rate: 0.2 },
      { accountingTaxType: 'REVERSECHARGE', rate: 0 },
    ]),
    label: 'RC widget',
  })
  assert.equal(identity.ok, false)
  assert.match(identity.ok ? '' : identity.reason, /was charged at 20% but/)
  assert.match(identity.ok ? '' : identity.reason, /REVERSECHARGE, which is 0%/)
})

test("shipping's charged rate comes from ITS OWN money, not the order's header rate (o3d-w00 Codex r5 #1)", () => {
  // SalesOrder.taxRatePercent is the order's HEADER DEFAULT — the rate createSalesOrder charged
  // shipping/fees/discount at, and the rate the importer resolved for the order as a whole. On an order
  // whose shipping was taxed unlike its goods it is not shipping's rate at all, and r4 read it as one.
  //
  // Zero-rated delivery on 20% goods. The header says 20%; the postage bore no VAT whatever. The credit
  // note posts shipping under the order-default identity (OUTPUT2, 20%), so recording £10 of postage
  // would store £8.33 net and credit £1.67 of VAT the customer never paid — on an order that reconciled
  // to the penny. Reading the header default agreed with the posting rate and let it through.
  const zeroRatedShipping = resolvePostedRefundTaxIdentity({
    kind: 'shipping',
    orderDefaultTaxType: 'OUTPUT2',
    chargedShipping: SHIPPING_CHARGED_0,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Shipping',
  })
  assert.equal(zeroRatedShipping.ok, false, 'the postage bore no VAT, and the credit note would post 20%')
  assert.match(zeroRatedShipping.ok ? '' : zeroRatedShipping.reason, /Shipping was charged at 0% but/)
  assert.match(zeroRatedShipping.ok ? '' : zeroRatedShipping.reason, /OUTPUT2, which is 20%/)
  // And the refusal names something that can actually be done about it.
  assert.match(zeroRatedShipping.ok ? '' : zeroRatedShipping.reason, /allocate this refund to the order lines/)

  // The mirror image, which the header rate got wrong in the other direction: standard-rated delivery on
  // zero-rated goods. Shipping's own money says 20%, the credit note posts at 20%, and the refund is
  // perfectly recordable — reading the header (0% on this order) would have refused it for nothing.
  const taxedShippingOnZeroRatedGoods = resolvePostedRefundTaxIdentity({
    kind: 'shipping',
    orderDefaultTaxType: 'OUTPUT2',
    chargedShipping: SHIPPING_CHARGED_20,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Shipping',
  })
  assert.equal(taxedShippingOnZeroRatedGoods.ok, true)
  assert.equal(taxedShippingOnZeroRatedGoods.ok && taxedShippingOnZeroRatedGoods.vatRate.toString(), '0.2')

  // An admin editing the default rate row is still caught, exactly as a line's edit is: shipping was
  // charged 20% and the code it posts under is now worth 5%.
  const edited = resolvePostedRefundTaxIdentity({
    kind: 'shipping',
    orderDefaultTaxType: 'OUTPUT2',
    chargedShipping: SHIPPING_CHARGED_20,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.05 }]),
    label: 'Shipping',
  })
  assert.equal(edited.ok, false)
  assert.match(edited.ok ? '' : edited.reason, /Shipping was charged at 20% but/)
})

test('shipping is refused when its VAT cannot be separated out of the order (o3d-w00 Codex r5 #1)', () => {
  const resolve = (chargedShipping: Omit<NonNullable<Parameters<typeof chargedRateFromShippingSnapshot>[0]>, 'currency'>) =>
    resolvePostedRefundTaxIdentity({
      kind: 'shipping',
      orderDefaultTaxType: 'OUTPUT2',
      chargedShipping: { currency: 'GBP', ...chargedShipping },
      rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
      label: 'Shipping',
    })

  // The order's total VAT was not read. Absent is not zero, and zero would price shipping at 0%.
  const unread = resolve({ netForeign: 10, lineTaxForeign: [0] })
  assert.equal(unread.ok, false)
  assert.match(unread.ok ? '' : unread.reason, /stores no VAT figure of its own for a shipping charge/)

  // Only SOME lines were read. The residue is then larger than shipping's VAT — here it would price
  // £10 of postage at 20% when the unread second line is carrying that VAT.
  const partial = resolve({ netForeign: 10, orderTaxForeign: 2, lineTaxForeign: [0, undefined] })
  assert.equal(partial.ok, false)
  assert.match(partial.ok ? '' : partial.reason, /not every order line's VAT was read/)

  // An order-level discount: createSalesOrder nets ITS VAT off the same total, so the residue is
  // shipping's VAT minus the discount's and neither can be recovered from it. Here the residue is 2.00
  // (20% of the postage) purely because the £12 discount's £2 of VAT cancels the £4 the postage bore.
  const discounted = resolve({ netForeign: 10, orderTaxForeign: 22, lineTaxForeign: [20], orderDiscountAmount: 12 })
  assert.equal(discounted.ok, false)
  assert.match(discounted.ok ? '' : discounted.reason, /order-level discount \(12\.0000\)/)

  // A residue that has gone negative is not a rate at all — the order records less VAT than its lines.
  const negative = resolve({ netForeign: 10, orderTaxForeign: 1, lineTaxForeign: [20], orderDiscountAmount: 0 })
  assert.equal(negative.ok, false)
  assert.match(negative.ok ? '' : negative.reason, /less VAT \(1\.0000\) than its own lines carry \(20\.0000\)/)

  // Every one of them names the way out, and none of them guesses.
  for (const refused of [unread, partial, discounted, negative]) {
    assert.match(refused.ok ? '' : refused.reason, /Allocate this refund to the order lines it came off/)
    assert.doesNotMatch(refused.ok ? '' : refused.reason, /was charged at/)
  }
})

test("a sale line with NO tax rate row posts under the order's single identity (o3d-w00 Codex r4 #2)", () => {
  // refund-service does not treat such a line as line-linked at all: it falls through to the order's
  // single safe identity. Resolving it here as "the order default" instead would make the pre-flight
  // and the posting disagree by construction, before any race.
  const uniformLines = [
    { taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false } },
    { taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false } },
  ]
  const uniform = resolveOrderUniformTaxIdentity({ lines: uniformLines, reverseChargeSalesTaxType: '' })
  assert.deepEqual(uniform, { singleSafeTaxType: 'OUTPUT2', uniformlyReverseCharged: false })

  const onUniformOrder = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: null,
    chargedLine: CHARGED_20,
    // Deliberately DIFFERENT from the single safe identity: if the resolver reached for the order
    // default it would price this line at 0% and store the operator's whole gross as net.
    orderDefaultTaxType: 'ZERORATEDOUTPUT',
    orderUniform: uniform,
    rateByTaxType: index([
      { accountingTaxType: 'OUTPUT2', rate: 0.2 },
      { accountingTaxType: 'ZERORATEDOUTPUT', rate: 0 },
    ]),
    label: 'Untaxed line',
  })
  assert.equal(onUniformOrder.ok, true)
  assert.equal(onUniformOrder.ok && onUniformOrder.accountingTaxType, 'OUTPUT2')

  // And on a MIXED order there is no single identity, so there is nothing to post it under — which is
  // what the posting would have found too, after the money had already been converted.
  const mixed = resolveOrderUniformTaxIdentity({
    lines: [
      { taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false } },
      { taxRate: { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: false } },
    ],
    reverseChargeSalesTaxType: '',
  })
  assert.equal(mixed.singleSafeTaxType, null)

  const onMixedOrder = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: null,
    chargedLine: CHARGED_20,
    orderDefaultTaxType: 'OUTPUT2',
    orderUniform: mixed,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Untaxed line',
  })
  assert.equal(onMixedOrder.ok, false)
  assert.match(onMixedOrder.ok ? '' : onMixedOrder.reason, /this order is not taxed uniformly/)
})

test('a fully reverse-charged order keeps its single identity, a part-reverse-charged one does not (o3d-w00)', () => {
  const allRc = resolveOrderUniformTaxIdentity({
    lines: [
      { taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: true } },
      { taxRate: { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: true } },
    ],
    reverseChargeSalesTaxType: 'REVERSECHARGE',
  })
  assert.deepEqual(allRc, { singleSafeTaxType: 'REVERSECHARGE', uniformlyReverseCharged: true })

  // The swap is what made them uniform; without it each keeps its own base code.
  const unconfigured = resolveOrderUniformTaxIdentity({
    lines: [
      { taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: true } },
      { taxRate: { accountingTaxType: 'ZERORATEDOUTPUT', reverseCharge: true } },
    ],
    reverseChargeSalesTaxType: '',
  })
  assert.equal(unconfigured.singleSafeTaxType, null)

  const mixture = resolveOrderUniformTaxIdentity({
    lines: [
      { taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: true } },
      { taxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false } },
    ],
    reverseChargeSalesTaxType: 'REVERSECHARGE',
  })
  assert.equal(mixture.singleSafeTaxType, null, 'an RC line beside a VAT-bearing one is two identities')
})

test('the displayed charged rate is the order line, or nothing (o3d-w00 Codex r4 #1)', () => {
  assert.equal(chargedRateFromLineSnapshot(CHARGED_20)?.toString(), '0.2')
  assert.equal(chargedRateFromLineSnapshot(CHARGED_0)?.toString(), '0')
  assert.equal(chargedRateFromLineSnapshot({ currency: 'GBP', netForeign: 0, taxForeign: 0 }), null)
  assert.equal(chargedRateFromLineSnapshot({ currency: 'GBP', netForeign: 10 }), null)
  assert.equal(chargedRateFromLineSnapshot(null), null)
})

test('the displayed charged rate for shipping is the order, or nothing (o3d-w00 Codex r5 #1)', () => {
  // A refused shipping row still has to read truthfully. Showing the order's HEADER rate would put 20%
  // beside a postage charge that bore no VAT — the same substitution, surviving on the screen.
  assert.equal(chargedRateFromShippingSnapshot(SHIPPING_CHARGED_0)?.toString(), '0')
  assert.equal(chargedRateFromShippingSnapshot(SHIPPING_CHARGED_20)?.toString(), '0.2')
  assert.equal(chargedRateFromShippingSnapshot({ ...SHIPPING_CHARGED_20, orderDiscountAmount: 5 }), null)
  assert.equal(chargedRateFromShippingSnapshot({ currency: 'GBP', netForeign: 10, lineTaxForeign: [0] }), null)
  assert.equal(chargedRateFromShippingSnapshot({ ...SHIPPING_CHARGED_20, netForeign: 0 }), null)
  assert.equal(chargedRateFromShippingSnapshot(null), null)
})

test('a zero-decimal currency is priced against ITS minor unit, not the penny (o3d-w00 Codex r6 #2)', () => {
  const at = (chargedLine: { currency: string; netForeign: number; taxForeign: number }, postedRate: number) =>
    resolvePostedRefundTaxIdentity({
      kind: 'sale',
      lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
      chargedLine,
      orderDefaultTaxType: 'OUTPUT2',
      rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: postedRate }]),
      label: 'Line',
    })

  // ---------------------------------------------------------------------------------------------
  // r5 sized a figure's rounding exposure to "the penny or finer" and noted that a 0-decimal currency
  // would then get a bound that is too TIGHT — fail-closed, but a refusal with NOTHING an operator can
  // do about it, which the epic treats as a defect in its own right.
  //
  // JPY has no minor unit, so a source quantises ¥499.50 to ¥500. ¥500 of VAT on ¥4,995 of net is an
  // entirely ordinary 10% Japanese line and reads as 10.01% — 1.0e-4 from the rate its code carries.
  // Priced as if the source had rounded to 0.01 the bound is (0.005 + 0.1 x 0.005) / 4995 = 1.1e-6, a
  // hundredfold too tight. Priced against the YEN it is (0.5 + 0.1 x 0.5) / 4995 = 1.10e-4, and the
  // line records.
  // ---------------------------------------------------------------------------------------------
  const yen = at({ currency: 'JPY', netForeign: 4995, taxForeign: 500 }, 0.1)
  assert.equal(yen.ok, true, 'a real 10% JPY line: 500 of VAT on 4,995 reads as 10.01%')
  assert.equal(yen.ok && yen.vatRate.toString(), '0.1')

  // The SAME two numbers in a 2-decimal currency are NOT that line: £500.00 of VAT on £4,995.00 of net
  // could not have been rounded to more than half a penny, so 10.01% really is a different rate from
  // the 10% its code carries and the refusal stands. Nothing but the currency separates the two — which
  // is what makes the currency, not the magnitude of the figures, the thing that has to be read.
  const sterling = at({ currency: 'GBP', netForeign: 4995, taxForeign: 500 }, 0.1)
  assert.equal(sterling.ok, false, 'the same figures in GBP are a genuine 0.01pp divergence')
  assert.match(sterling.ok ? '' : sterling.reason, /was charged at 10\.01% but/)

  // Widening the bound is not a licence: a genuinely different rate on the same yen figures is still
  // caught, so the fix did not blunt the check it belongs to.
  const wrongRate = at({ currency: 'JPY', netForeign: 4995, taxForeign: 500 }, 0.08)
  assert.equal(wrongRate.ok, false)
  assert.match(wrongRate.ok ? '' : wrongRate.reason, /which is 8%/)

  // And the coarser minor unit makes SMALL amounts less able to pin a rate down, not more: ±0.5 on ¥100
  // of net leaves the rate uncertain by 0.0055, past the 0.002 cap, so the amount is treated as
  // carrying no usable snapshot rather than waved through.
  const tiny = at({ currency: 'JPY', netForeign: 100, taxForeign: 10 }, 0.1)
  assert.equal(tiny.ok, false, '¥100 of net cannot fix a rate when its figures are worth ±0.5 each')
  assert.match(tiny.ok ? '' : tiny.reason, /too small to fix the rate it was charged at/)
})

test("a WooCommerce order's shipping VAT survives an order-level discount (o3d-w00 Codex r6 #3)", () => {
  // £100 of 20% goods (£20 of VAT), £10 of postage bearing £2, and £12 of coupon that Woo could not
  // allocate to a line. The residue — 22.00 recorded less the 20.00 on the lines — is 2.00 on 10.00 of
  // postage, i.e. 20%, because computeWcOrderForeignTotals SUMS the components and subtracts no VAT for
  // the discount leg (Woo puts coupon money INSIDE the line totals). The identical figures written by
  // createSalesOrder mean something else entirely: it DOES net the discount's VAT off the same total,
  // so the residue there is shipping's VAT and the discount's mixed together.
  const snapshot = {
    currency: 'GBP',
    netForeign: 10,
    orderTaxForeign: 22,
    lineTaxForeign: [20],
    orderDiscountAmount: 12,
  }
  const resolve = (chargedShipping: typeof snapshot & { orderTaxIsSumOfComponents?: boolean }) =>
    resolvePostedRefundTaxIdentity({
      kind: 'shipping',
      orderDefaultTaxType: 'OUTPUT2',
      chargedShipping,
      rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
      label: 'Shipping',
    })

  const wooCommerce = resolve({ ...snapshot, orderTaxIsSumOfComponents: true })
  assert.equal(wooCommerce.ok, true, 'a WC order states its shipping VAT in the residue, discount or no discount')
  assert.equal(wooCommerce.ok && wooCommerce.vatRate.toString(), '0.2')
  assert.equal(
    chargedRateFromShippingSnapshot({ ...snapshot, orderTaxIsSumOfComponents: true })?.toString(),
    '0.2',
    'and a refused row still displays it',
  )

  // Unstated provenance keeps the conservative reading, so the refusal is narrowed, not removed.
  const unknownWriter = resolve(snapshot)
  assert.equal(unknownWriter.ok, false)
  assert.match(unknownWriter.ok ? '' : unknownWriter.reason, /order-level discount \(12\.0000\)/)
  assert.equal(chargedRateFromShippingSnapshot(snapshot), null)
})

test('a STATED shipping VAT is used instead of the residue (o3d-w00 Codex r6 #1)', () => {
  // The residue exists only because SalesOrder stores no shipping-VAT column. A WooCommerce refund
  // payload states one per refunded shipping line, so the itemised route has a figure it did not have
  // to derive — and none of the residue's refusals (an unread line, an order-level discount, a negative
  // difference) can apply to it, because there is no order aggregate underneath it.
  const resolve = (chargedShipping: {
    currency: string
    netForeign: number
    shippingTaxForeign: number
  }, postedRate: number) =>
    resolvePostedRefundTaxIdentity({
      kind: 'shipping',
      orderDefaultTaxType: 'OUTPUT2',
      chargedShipping,
      rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: postedRate }]),
      label: 'Shipping',
    })

  const taxed = resolve({ currency: 'GBP', netForeign: 10, shippingTaxForeign: 2 }, 0.2)
  assert.equal(taxed.ok, true)
  assert.equal(taxed.ok && taxed.vatRate.toString(), '0.2')

  // £10 of postage that bore NO VAT, against a code worth 20%: the credit note would come to £12.00
  // for a £10.00 refund. This is the divergence the stated figure exists to catch.
  const zeroRated = resolve({ currency: 'GBP', netForeign: 10, shippingTaxForeign: 0 }, 0.2)
  assert.equal(zeroRated.ok, false)
  assert.match(zeroRated.ok ? '' : zeroRated.reason, /Shipping was charged at 0% but/)
  assert.match(zeroRated.ok ? '' : zeroRated.reason, /OUTPUT2, which is 20%/)

  // A stated figure is not a residue, so supplying an order aggregate alongside it changes nothing —
  // and in particular an order-level discount cannot refuse a figure nobody derived.
  const withOrderAggregate = resolvePostedRefundTaxIdentity({
    kind: 'shipping',
    orderDefaultTaxType: 'OUTPUT2',
    chargedShipping: {
      currency: 'GBP',
      netForeign: 10,
      shippingTaxForeign: 2,
      orderTaxForeign: 999,
      lineTaxForeign: [0],
      orderDiscountAmount: 12,
    },
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Shipping',
  })
  assert.equal(withOrderAggregate.ok, true)
  assert.equal(withOrderAggregate.ok && withOrderAggregate.vatRate.toString(), '0.2')
})

// ---------------------------------------------------------------------------------------------
// o3d-w00 Codex r7 #5: TWO QUESTIONS, TWO ANSWERS.
//
// The hand-recording path DIVIDES an operator's gross by the identity's rate, so a snapshot that
// cannot pin that rate down is unusable to it. The writer's fence already holds a NET amount and only
// the credit note's TOTAL can come out wrong, so it prices the identity and compares in money. Same
// identity, same refusals for an identity that cannot be established or priced — different question
// about the money underneath.
// ---------------------------------------------------------------------------------------------

test('pricing an identity is separable from checking what it was charged (o3d-w00 Codex r7 #5)', () => {
  const input = {
    kind: 'sale' as const,
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    // £2.00 bearing £0.40 is an ordinary 20% line whose DERIVED rate is uncertain by 0.3pp.
    chargedLine: { currency: 'GBP', netForeign: 2, taxForeign: 0.4 },
    orderDefaultTaxType: 'OUTPUT2',
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Line',
  }

  const forDivision = resolvePostedRefundTaxIdentity(input)
  assert.equal(forDivision.ok, false, 'a gross may not be divided by a rate this pair cannot fix')
  assert.match(forDivision.ok ? '' : forDivision.reason, /too small to fix the rate it was charged at/)

  const forPosting = priceRefundTaxIdentity(input)
  assert.equal(forPosting.ok, true, 'but the identity itself is perfectly well established and priced')
  assert.equal(forPosting.ok && forPosting.vatRate.toString(), '0.2')

  // And pricing still refuses what it must: an unmapped code is not a 0% one.
  const unpriced = priceRefundTaxIdentity({ ...input, rateByTaxType: index([]) })
  assert.equal(unpriced.ok, false)
  assert.match(unpriced.ok ? '' : unpriced.reason, /no IMS tax rate is\s+mapped to/)
})

test('the credit-note total check compares money, not rates (o3d-w00 Codex r7 #5)', () => {
  const check = (netForeign: number, taxForeign: number, postedRate: number, currency = 'GBP') =>
    postedCreditNoteTotalCheck({ currency, netForeign, taxForeign, postedRate: toDecimal(postedRate), kind: 'sale', label: 'The refunded line' })

  // The £2.00 line the rate comparison could not judge: 2.00 + 0.40 against 2.00 x 1.2 is exact.
  assert.equal(check(2, 0.4, 0.2).ok, true)
  // Zero-rated against a 20% code, at the SAME size: 2.00 against 2.40, and the tolerance bought nothing.
  const diverges = check(2, 0, 0.2)
  assert.equal(diverges.ok, false)
  assert.match(diverges.ok ? '' : diverges.reason, /returned 2\.00 of the customer's money/)
  assert.match(diverges.ok ? '' : diverges.reason, /credit note would come to 2\.40/)

  // A penny of rounding is not a divergence — the charged VAT reached IMS rounded to the minor unit and
  // the ledger rounds its own the same way.
  assert.equal(check(4.99, 1, 0.2).ok, true, '4.99 x 1.2 = 5.988 against a penny-rounded 5.99')
  // The minor unit is the CURRENCY's, not the penny: ¥4,995 + ¥500 against ¥4,995 x 1.1 = ¥5,494.5.
  assert.equal(check(4995, 500, 0.1, 'JPY').ok, true)
  // …and it is not a licence: a genuinely different rate on the same yen figures is still caught.
  assert.equal(check(4995, 500, 0.08, 'JPY').ok, false)

  // No snapshot means there is NOTHING to check the posting against — never that it agrees.
  assert.equal(postedCreditNoteTotalCheck({ currency: 'GBP', netForeign: 10, postedRate: toDecimal(0.2), kind: 'sale', label: 'x' }).ok, true)
  assert.equal(postedCreditNoteTotalCheck({ currency: 'GBP', netForeign: 0, taxForeign: 0, postedRate: toDecimal(0.2), kind: 'sale', label: 'x' }).ok, true)

  // o3d-w00 (Codex r8 #5): a chargeback's shipping and order-discount legs are checked as ONE amount,
  // and the discount leg is negative by construction, so the pair's net can be either sign. One refund
  // LINE is never negative and one of zero credits nothing, so both stay unchecked by default.
  const combined = (netForeign: number, taxForeign: number, postedRate: number) => postedCreditNoteTotalCheck({
    currency: 'GBP', netForeign, taxForeign, postedRate: toDecimal(postedRate),
    kind: 'shipping', label: 'The pair', allowNonPositiveNet: true,
  })
  // £4.00 of postage less a £10.00 discount is −£6.00 net bearing −£1.20 of VAT: −7.20 either way.
  assert.equal(combined(-6, -1.2, 0.2).ok, true)
  assert.equal(combined(-6, -1.2, 0.05).ok, false, 'and a moved rate is caught on a negative pair too')
  // Without the flag the same figures are waved through, which is why the two chargeback legs cannot
  // simply be handed to the per-line check.
  assert.equal(postedCreditNoteTotalCheck({
    currency: 'GBP', netForeign: -6, taxForeign: -1.2, postedRate: toDecimal(0.05), kind: 'shipping', label: 'The pair',
  }).ok, true)
})

test('the shipping residue and its refusals are shared with the money check (o3d-w00 Codex r7 #5)', () => {
  // Whatever is done with shipping's VAT afterwards, it is only shipping's VAT when nothing else was
  // netted off the same total — so the refusals belong to the extraction, not to one consumer of it.
  const derived = chargedShippingMoney(SHIPPING_CHARGED_20)
  assert.equal(derived.ok, true)
  assert.equal(derived.ok && derived.taxForeign.toString(), '2')
  assert.equal(derived.ok && derived.netForeign.toString(), '10')

  const discounted = chargedShippingMoney({ ...SHIPPING_CHARGED_20, orderDiscountAmount: 5 })
  assert.equal(discounted.ok, false, "a discount's VAT is netted off the same total by createSalesOrder")

  const stated = chargedShippingMoney({ currency: 'GBP', netForeign: 10, shippingTaxForeign: 0, orderDiscountAmount: 5 })
  assert.equal(stated.ok, true, 'a STATED figure is not a residue, so no residue refusal applies to it')
  assert.equal(stated.ok && stated.taxForeign.toString(), '0')
})

test('the aggregate check catches a drift every leg hides inside its own tolerance (o3d-w00 Codex r8 #1)', () => {
  const leg = (postedNet: number, chargedTax: number, postedRate: number, label = 'line') => ({
    label,
    postedNetForeign: postedNet,
    chargedNetForeign: postedNet,
    chargedTaxForeign: chargedTax,
    postedRate: toDecimal(postedRate),
  })
  const check = (legs: ReturnType<typeof leg>[], currency = 'GBP') =>
    postedCreditNoteAggregateCheck({ currency, legs })

  // £1.00 charged at 19% posting under a 20% code is out by exactly £0.01 — one minor unit, so the
  // per-leg check passes it every time, at any number of repetitions. Each of these legs passes on its
  // own; a hundred of them add up to a credit note £1.00 over the refund it settles.
  const perLeg = postedCreditNoteTotalCheck({
    currency: 'GBP', netForeign: 1, taxForeign: 0.19, postedRate: toDecimal(0.2), kind: 'sale', label: 'line',
  })
  assert.equal(perLeg.ok, true, 'the premise: no single leg is refusable')

  const hundred = check(Array.from({ length: 100 }, () => leg(1, 0.19, 0.2)))
  assert.equal(hundred.ok, false)
  assert.match(hundred.ok ? '' : hundred.reason, /returned 119\.00 of the customer's money across 100 parts/)
  assert.match(hundred.ok ? '' : hundred.reason, /credit note.*would come to 120\.00/)
  assert.match(hundred.ok ? '' : hundred.reason, /1\.00 over/)

  // One leg can never be refused here — it is the per-leg check's business, and refusing it twice with
  // two different tolerances would only make the narrower one the real rule.
  assert.equal(check([leg(1, 0.19, 0.2)]).ok, true)
  // Two is still inside the slack; by three the systematic part has outgrown the rounding it hides in.
  assert.equal(check([leg(1, 0.19, 0.2), leg(1, 0.19, 0.2)]).ok, true)
  assert.equal(check(Array.from({ length: 3 }, () => leg(1, 0.19, 0.2))).ok, false)

  // And the legs that merely ROUND awkwardly are not refused, however many there are. £4.99 at 20% is
  // £0.998 of VAT, which WooCommerce stores as £1.00 — a real 20% line whose derived rate is 20.04%.
  assert.equal(check(Array.from({ length: 100 }, () => leg(4.99, 1, 0.2))).ok, true)
  // The same, priced INCLUSIVE of tax: £9.99 gross at 20% splits as 8.33 + 1.66, deriving 19.928%.
  assert.equal(check(Array.from({ length: 100 }, () => leg(8.33, 1.66, 0.2))).ok, true)
  // Mixed rounding in both directions cancels rather than accumulating.
  assert.equal(check([...Array.from({ length: 50 }, () => leg(4.99, 1, 0.2)), ...Array.from({ length: 50 }, () => leg(8.33, 1.66, 0.2))]).ok, true)

  // A leg refunded in PART is priced against the whole line's snapshot but posts only its own net, so
  // both its drift and its rounding allowance scale with what is actually credited.
  assert.equal(
    postedCreditNoteAggregateCheck({
      currency: 'GBP',
      legs: Array.from({ length: 20 }, () => ({
        label: 'half a line',
        postedNetForeign: 0.5,
        chargedNetForeign: 1,
        chargedTaxForeign: 0.19,
        postedRate: toDecimal(0.2),
      })),
    }).ok,
    false,
  )

  // The rounding allowed is the CURRENCY's, not the penny's. ¥499 at 20% is ¥99.8 of VAT, quantised to
  // ¥100 — ordinary yen rounding, and 100 such legs are not a divergence...
  assert.equal(check(Array.from({ length: 100 }, () => leg(499, 100, 0.2)), 'JPY').ok, true)
  // ...while the identical figures in a currency quantised to the penny are, because in GBP nothing
  // rounded them: 499.00 bearing 100.00 was charged at 20.04%, and 100 legs of it is £20.00 of drift.
  assert.equal(check(Array.from({ length: 100 }, () => leg(499, 100, 0.2))).ok, false)
  // A rate difference big enough to outrun even yen rounding is still caught.
  assert.equal(check(Array.from({ length: 100 }, () => leg(100, 19, 0.2)), 'JPY').ok, false)

  // Legs with nothing on one side of the comparison price nothing and are skipped, not treated as zero.
  assert.equal(check([leg(0, 0, 0.2), leg(0, 0, 0.2)]).ok, true)
})

test("the aggregate prices the net side's rounding at the rate the credit note posts under (o3d-w00 Codex r9 #1)", () => {
  const leg = (postedNet: number, chargedTax: number, postedRate: number, label = 'line') => ({
    label,
    postedNetForeign: postedNet,
    chargedNetForeign: postedNet,
    chargedTaxForeign: chargedTax,
    postedRate: toDecimal(postedRate),
  })
  const check = (legs: ReturnType<typeof leg>[], currency = 'GBP') =>
    postedCreditNoteAggregateCheck({ currency, legs })

  // ---------------------------------------------------------------------------------------------
  // TOO TIGHT — the direction r8 introduced. The rounding a leg is allowed is
  // halfUnit(tax) + rate x halfUnit(net); r8 evaluated `rate` there as the rate DERIVED from the very
  // pair whose rounding it is bounding, so every leg that rounded DOWN was allowed less than it could
  // legitimately be out by, by exactly the amount that made it round down. One-signed, so it
  // accumulated.
  //
  // A perfectly ordinary 20% item sold tax-inclusive at £0.15: net 0.125 and VAT 0.025, which the
  // storefront stores as 0.13 + 0.02. Its drift is 0.13 x 0.20 − 0.02 = £0.006 — the very largest a
  // penny-quantised pair CAN be out by (0.005 of tax rounding plus 0.20 x 0.005 of net rounding).
  // r8 allowed 0.005 + 0.153846 x 0.005 = £0.005769 for it, LESS than its own rounding, so the
  // shortfall of £0.000231 a leg exhausted the £0.01 of slack at the 44th line and refused a refund
  // whose tax codes are all correctly mapped and which no operator could do anything about.
  const roundedDown = leg(0.13, 0.02, 0.2)
  assert.equal(
    postedCreditNoteTotalCheck({
      currency: 'GBP', netForeign: 0.13, taxForeign: 0.02, postedRate: toDecimal(0.2), kind: 'sale', label: 'line',
    }).ok,
    true,
    'the premise: each leg passes on its own — this is ordinary penny rounding, not a rate difference',
  )
  assert.equal(check(Array.from({ length: 44 }, () => roundedDown)).ok, true, 'r8 refused this one')
  assert.equal(check(Array.from({ length: 200 }, () => roundedDown)).ok, true, 'and it never accumulates')
  // The same worst-case rounding at a different rate: £0.13 at 5% is £0.0065 of VAT, stored as £0.01.
  assert.equal(check(Array.from({ length: 500 }, () => leg(0.13, 0.01, 0.05))).ok, true)

  // ---------------------------------------------------------------------------------------------
  // TOO LOOSE — the direction r8 was itself fixing, which the correction must not reopen. What the
  // net side is now allowed is at most rate x half a minor unit of net, so a leg out by a WHOLE minor
  // unit still carries ~£0.004 of drift nothing explains, and three of them still cross the bound.
  assert.equal(check([leg(1, 0.19, 0.2), leg(1, 0.19, 0.2)]).ok, true, 'two is still inside the slack')
  assert.equal(check(Array.from({ length: 3 }, () => leg(1, 0.19, 0.2))).ok, false)
  assert.equal(check(Array.from({ length: 100 }, () => leg(1, 0.19, 0.2))).ok, false)
  // Half a percentage point — the smallest gap between two REAL VAT rates — is still caught, and the
  // wider allowance buys the wrong rate no more than one extra leg.
  assert.equal(check(Array.from({ length: 4 }, () => leg(1, 0.195, 0.2))).ok, false)
  // A rate error on the CHARGED side is symmetrical: the larger of the two rates prices the net side,
  // so a leg charged ABOVE what it posts under is allowed no more than r8 allowed it.
  assert.equal(check(Array.from({ length: 3 }, () => leg(1, 0.21, 0.2))).ok, false)
})
