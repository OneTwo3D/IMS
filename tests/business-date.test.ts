import assert from 'node:assert/strict'
import test from 'node:test'
import { businessDateYmd } from '../lib/business-date.ts'
import { invoiceLineVatDetail, orderDocumentMoney, REVERSE_CHARGE_WORDING } from '../lib/pdf-order-money.ts'
import { documentVatRows } from '../lib/pdf.ts'

test('an order placed at 00:30 BST on 1 July is dated 1 July, not 30 June (the UTC day)', () => {
  const instant = new Date('2026-06-30T23:30:00.000Z') // 00:30 BST on 1 July
  assert.equal(instant.toISOString().slice(0, 10), '2026-06-30')
  assert.equal(businessDateYmd(instant), '2026-07-01')
})

test('in winter (GMT) the business day equals the UTC day, and 23:30 UTC stays the same day', () => {
  assert.equal(businessDateYmd(new Date('2026-01-15T00:30:00.000Z')), '2026-01-15')
  assert.equal(businessDateYmd(new Date('2026-01-15T23:30:00.000Z')), '2026-01-15')
})

test('the clock change days resolve to the London calendar day', () => {
  assert.equal(businessDateYmd(new Date('2026-03-28T23:59:00.000Z')), '2026-03-28') // before the change: GMT
  assert.equal(businessDateYmd(new Date('2026-03-29T23:30:00.000Z')), '2026-03-30') // after: 00:30 BST
  assert.equal(businessDateYmd(new Date('2026-10-24T23:30:00.000Z')), '2026-10-25') // 00:30 BST, before the clocks go back
})

test('invoice lines print their own VAT rate; a reverse-charge line prints the reverse-charge wording', () => {
  const plain = invoiceLineVatDetail([{ taxRate: { rate: 0.2 } }, { taxRate: { rate: 0.05 } }, { taxRate: { rate: 0 } }, { taxRate: null }])
  assert.deepEqual(plain.rateCells, ['20%', '5%', '0%', '-'])
  assert.equal(plain.reverseChargeNote, null)
  const rc = invoiceLineVatDetail([{ taxRate: { rate: 0.2, reverseCharge: false } }, { taxRate: { rate: 0, reverseCharge: true } }])
  assert.deepEqual(rc.rateCells, ['20%', 'Reverse charge'])
  assert.equal(rc.reverseChargeNote, REVERSE_CHARGE_WORDING)
})

test('mixed-rate order with an order discount: the VAT rows add up to the stored VAT, the discount VAT sitting on the default rate as posted', () => {
  // 100 @20% + 100 @5%, GBP 20 order discount posted on the 20% default rate (-4 VAT): stored VAT 21.
  const vat = documentVatRows({
    taxRateName: 'VAT', taxRatePercent: 0.2, taxForeign: 21,
    lines: [{ taxRatePercent: 0.2, taxForeign: 20 }, { taxRatePercent: 0.05, taxForeign: 5 }],
  })
  assert.deepEqual(vat, [{ label: 'VAT @ 20%', amount: 16 }, { label: 'VAT @ 5%', amount: 5 }])
  assert.equal(vat.reduce((s, r) => s + r.amount, 0), 21)
  const money = orderDocumentMoney({
    pricesIncludeVat: false, shoppingLinks: [], taxRateName: 'VAT', taxRatePercent: 0.2,
    subtotalForeign: 200, discountAmount: 20, shippingForeign: 0, taxForeign: 21, totalForeign: 201,
    lines: [
      { qty: 1, unitPriceForeign: 100, totalForeign: 100, taxForeign: 20, taxRate: { rate: 0.2 } },
      { qty: 1, unitPriceForeign: 100, totalForeign: 100, taxForeign: 5, taxRate: { rate: 0.05 } },
    ],
  })
  assert.equal(money.view.reconciles, true)
})
