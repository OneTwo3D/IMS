import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTaxTypeRateIndex,
  chargedRateFromLineSnapshot,
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
    orderChargedRate: 0.2,
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
    orderChargedRate: 0.2,
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
      orderChargedRate: 0.2,
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

test('the derived rate carries its own rounding, and is refused once that swamps it (o3d-w00 Codex r4 #1)', () => {
  // net and tax are each stored to Decimal(18,4), so `tax / net` is uncertain by (1 + rate) x 0.00005
  // / net. A 35p line sold at 20% tax-inclusive stores 0.2917 net and 0.0583 of VAT — 19.9863% as
  // stored, 1.37e-4 away from the 20% it was really sold at, which is four times the flat epsilon two
  // STORED rates are compared with. Refusing that line for its own storage rounding would be a refusal
  // with no remedy at all: there is nothing the operator could fix.
  const smallButUsable = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    chargedLine: { netForeign: 0.2917, taxForeign: 0.0583 },
    orderDefaultTaxType: 'OUTPUT2',
    orderChargedRate: 0.2,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Small line',
  })
  assert.equal(smallButUsable.ok, true, 'a 35p line still pins its rate to well inside a rate difference')

  // A 3p line pins nothing: the uncertainty is 0.2 of a percentage point, wider than the gap between
  // real VAT rates, so the comparison could no longer do the job it exists for. Refused as carrying no
  // usable snapshot rather than waved through on a tolerance that hides the defect.
  const tooSmall = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    chargedLine: { netForeign: 0.03, taxForeign: 0.006 },
    orderDefaultTaxType: 'OUTPUT2',
    orderChargedRate: 0.2,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Penny line',
  })
  assert.equal(tooSmall.ok, false)
  assert.match(tooSmall.ok ? '' : tooSmall.reason, /too small to fix the rate it was charged at/)

  // And the tolerance is not a licence: a genuinely different rate on the same small line is still
  // caught, so widening it did not blunt the check.
  const wrongRate = resolvePostedRefundTaxIdentity({
    kind: 'sale',
    lineTaxRate: { accountingTaxType: 'OUTPUT2', reverseCharge: false },
    chargedLine: { netForeign: 0.2917, taxForeign: 0.0583 },
    orderDefaultTaxType: 'OUTPUT2',
    orderChargedRate: 0.2,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.19 }]),
    label: 'Small line',
  })
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
    orderChargedRate: 0.2,
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
    orderChargedRate: 0.2,
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
    orderChargedRate: 0.2,
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
    orderChargedRate: 0.2,
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

test("shipping is priced from the ORDER's own taxRatePercent (o3d-w00 Codex r4 #1)", () => {
  // Shipping has no line of its own, so its charged rate comes from SalesOrder.taxRatePercent — an
  // order column written alongside the money at creation/import, never read back through the TaxRate
  // table. It is therefore already historical, and an admin editing the default rate row is caught here
  // the same way a line's is.
  const edited = resolvePostedRefundTaxIdentity({
    kind: 'shipping',
    orderDefaultTaxType: 'OUTPUT2',
    orderChargedRate: 0.2,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.05 }]),
    label: 'Shipping',
  })
  assert.equal(edited.ok, false)
  assert.match(edited.ok ? '' : edited.reason, /Shipping was charged at 20% but/)

  const unedited = resolvePostedRefundTaxIdentity({
    kind: 'shipping',
    orderDefaultTaxType: 'OUTPUT2',
    orderChargedRate: 0.2,
    rateByTaxType: index([{ accountingTaxType: 'OUTPUT2', rate: 0.2 }]),
    label: 'Shipping',
  })
  assert.equal(unedited.ok, true)
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
    orderChargedRate: 0.2,
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
    orderChargedRate: 0.2,
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
