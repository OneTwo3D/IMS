import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTaxTypeRateIndex,
  chargedRateFromLineSnapshot,
  chargedRateFromShippingSnapshot,
  resolveOrderUniformTaxIdentity,
  resolvePostedRefundTaxIdentity,
} from '@/lib/domain/sales/refund-posted-tax-identity'

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
const CHARGED_20 = { netForeign: 10, taxForeign: 2 }
/** £20.00 net with no VAT: sold zero-rated. */
const CHARGED_0 = { netForeign: 20, taxForeign: 0 }

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
  netForeign: 10,
  orderTaxForeign: 20,
  lineTaxForeign: [20],
  orderDiscountAmount: 0,
}
/** £10 of postage carrying £2.00 of VAT on ZERO-rated goods: every penny of the order's VAT is shipping's. */
const SHIPPING_CHARGED_20 = {
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
      chargedLine,
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
      chargedLine,
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
    chargedLine: { netForeign: 10, taxForeign: 0 },
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
    chargedLine: { netForeign: 10, taxForeign: 0 },
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
    chargedLine: { netForeign: 10, taxForeign: 0 },
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
  const resolve = (chargedShipping: Parameters<typeof chargedRateFromShippingSnapshot>[0]) =>
    resolvePostedRefundTaxIdentity({
      kind: 'shipping',
      orderDefaultTaxType: 'OUTPUT2',
      chargedShipping,
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
  assert.equal(chargedRateFromLineSnapshot({ netForeign: 0, taxForeign: 0 }), null)
  assert.equal(chargedRateFromLineSnapshot({ netForeign: 10 }), null)
  assert.equal(chargedRateFromLineSnapshot(null), null)
})

test('the displayed charged rate for shipping is the order, or nothing (o3d-w00 Codex r5 #1)', () => {
  // A refused shipping row still has to read truthfully. Showing the order's HEADER rate would put 20%
  // beside a postage charge that bore no VAT — the same substitution, surviving on the screen.
  assert.equal(chargedRateFromShippingSnapshot(SHIPPING_CHARGED_0)?.toString(), '0')
  assert.equal(chargedRateFromShippingSnapshot(SHIPPING_CHARGED_20)?.toString(), '0.2')
  assert.equal(chargedRateFromShippingSnapshot({ ...SHIPPING_CHARGED_20, orderDiscountAmount: 5 }), null)
  assert.equal(chargedRateFromShippingSnapshot({ netForeign: 10, lineTaxForeign: [0] }), null)
  assert.equal(chargedRateFromShippingSnapshot({ ...SHIPPING_CHARGED_20, netForeign: 0 }), null)
  assert.equal(chargedRateFromShippingSnapshot(null), null)
})
