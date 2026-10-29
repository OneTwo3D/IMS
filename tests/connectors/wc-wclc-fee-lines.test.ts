/**
 * Mirror of the wclc EU customs fee lines (EU Import Duty, EU Customs Fee, >EUR 150 Import Duty).
 *
 * D5: WooCommerce calculates, IMS mirrors. These tests pin that the importer's fee-line mapper carries each
 * fee line's NET and its WooCommerce TAX exactly as reported (no recomputation, no assumption of zero tax),
 * that the document-tax reconciliation and WooCommerce's own reported totals treat a taxed fee line as net +
 * tax counted once, and that an old untaxed order maps exactly as it did before the fees became taxable.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as fieldMappingNs from '../../lib/connectors/woocommerce/sync/field-mapping.ts'
import * as couponNs from '../../lib/connectors/woocommerce/sync/coupon-classification.ts'
import * as orderImportNs from '../../lib/connectors/woocommerce/sync/order-import.ts'
import type { WcFeeLine, WcFullOrder } from '../../lib/connectors/woocommerce/sync/types.ts'

type Mod<T> = T
function unwrap<T extends object>(ns: T): Mod<T> {
  return ('default' in ns ? (ns as { default: T }).default : ns) as T
}
const { mapWcFeeLines, readWclcFeeKind } = unwrap(fieldMappingNs)
const { wcReportedOrderAmounts } = unwrap(couponNs)
const { reconcileWcDocumentTax } = unwrap(orderImportNs)

const NL_STANDARD = 7 // an arbitrary WooCommerce tax-rate id: the mapper passes it through untouched

function fee(
  id: number,
  name: string,
  total: string,
  totalTax: string,
  kind: 'duty_flat' | 'uhf' | 'duty_fee' | null,
  rateId: number | null = NL_STANDARD,
): WcFeeLine {
  return {
    id,
    name,
    tax_class: '',
    total,
    total_tax: totalTax,
    taxes: rateId !== null && totalTax !== '0.00' ? [{ id: rateId, total: totalTax }] : [],
    meta_data: kind
      ? [
          { id: id * 10, key: '_wclc_fee', value: '1' },
          { id: id * 10 + 1, key: '_wclc_fee_kind', value: kind },
        ]
      : [],
  }
}

test('taxed EU Import Duty and EU Customs Fee: net, tax, rate id and kind are mirrored, not recomputed', () => {
  // Netherlands 21%: EUR 3 -> 0.63, EUR 2 -> 0.42, two distinct HS codes -> two units each.
  const lines = mapWcFeeLines([
    fee(101, 'EU Import Duty', '6.00', '1.26', 'duty_flat'),
    fee(102, 'EU Customs Fee', '4.00', '0.84', 'uhf'),
  ])
  assert.equal(lines.length, 2)
  const [duty, uhf] = lines
  assert.equal(duty.description, 'EU Import Duty')
  assert.equal(duty.unitPriceForeign, 6)
  assert.equal(duty.taxForeign, 1.26)
  assert.equal(duty.externalTaxRateId, NL_STANDARD)
  assert.equal(duty.forceNoTax, false)
  assert.equal(duty.wclcFeeKind, 'duty_flat')
  assert.equal(duty.qty, 1)
  assert.equal(duty.sku, '')
  assert.equal(duty.productId, null)
  assert.equal(duty.externalLineItemId, null)
  assert.equal(uhf.description, 'EU Customs Fee')
  assert.equal(uhf.unitPriceForeign, 4)
  assert.equal(uhf.taxForeign, 0.84)
  assert.equal(uhf.externalTaxRateId, NL_STANDARD)
  assert.equal(uhf.forceNoTax, false)
  assert.equal(uhf.wclcFeeKind, 'uhf')
})

test('a tax figure that disagrees with net x rate is mirrored as WooCommerce reported it (IMS never "fixes" it)', () => {
  const [line] = mapWcFeeLines([fee(103, 'EU Customs Fee', '2.00', '0.50', 'uhf')])
  assert.equal(line.taxForeign, 0.5)
  assert.equal(line.unitPriceForeign, 2)
})

test('over-EUR-150 order: the non-taxable Import Duty line (handling grossed by import VAT) stays untaxed', () => {
  // Dutify line: duty + import VAT + the EUR 2 UHF grossed by import VAT, all inside one NON-taxable fee.
  const [line] = mapWcFeeLines([fee(104, 'Import Duty', '53.40', '0.00', 'duty_fee', null)])
  assert.equal(line.unitPriceForeign, 53.4)
  assert.equal(line.taxForeign, 0)
  assert.equal(line.forceNoTax, true)
  assert.equal(line.externalTaxRateId, null)
  assert.equal(line.wclcFeeKind, 'duty_fee')
})

test('old untaxed order: fee lines with no meta map exactly as before (tax 0, forceNoTax, no kind)', () => {
  const legacy: WcFeeLine = { id: 9, name: 'EU Import Duty', tax_class: '', total: '3.00', total_tax: '0.00', taxes: [] }
  const [line] = mapWcFeeLines([legacy])
  assert.deepEqual(line, {
    productId: null,
    sku: '',
    description: 'EU Import Duty',
    qty: 1,
    unitPriceForeign: 3,
    discountAmount: 0,
    discountStr: null,
    taxForeign: 0,
    forceNoTax: true,
    externalTaxRateId: null,
    externalLineItemId: null,
    taxCategoryFallback: 'STANDARD',
    wclcFeeKind: null,
  })
  // A payload with no `taxes` key at all (older WooCommerce) behaves the same.
  const bare = { id: 10, name: 'Handling', total: '1.00', total_tax: '0.00' } as WcFeeLine
  assert.equal(mapWcFeeLines([bare])[0].forceNoTax, true)
})

test('an all-zero fee line is dropped, as before', () => {
  assert.deepEqual(mapWcFeeLines([fee(11, 'EU Customs Fee', '0.00', '0.00', 'uhf')]), [])
})

test('readWclcFeeKind: needs the marker, accepts only the known kinds, tolerates other truthy spellings', () => {
  const meta = (...pairs: Array<[string, unknown]>) => ({ meta_data: pairs.map(([key, value], id) => ({ id, key, value })) })
  assert.equal(readWclcFeeKind(meta(['_wclc_fee', '1'], ['_wclc_fee_kind', 'uhf'])), 'uhf')
  assert.equal(readWclcFeeKind(meta(['_wclc_fee', 1], ['_wclc_fee_kind', ' duty_flat '])), 'duty_flat')
  assert.equal(readWclcFeeKind(meta(['_wclc_fee', 'yes'], ['_wclc_fee_kind', 'duty_fee'])), 'duty_fee')
  assert.equal(readWclcFeeKind(meta(['_wclc_fee_kind', 'uhf'])), null) // kind without the marker
  assert.equal(readWclcFeeKind(meta(['_wclc_fee', '0'], ['_wclc_fee_kind', 'uhf'])), null)
  assert.equal(readWclcFeeKind(meta(['_wclc_fee', '1'], ['_wclc_fee_kind', 'something_new'])), null)
  assert.equal(readWclcFeeKind(meta(['_wclc_fee', '1'])), null)
  assert.equal(readWclcFeeKind({}), null)
})

test('VAT is counted once: a taxed fee line adds net to goods and its tax to tax in the reported totals', () => {
  const order = {
    line_items: [{ total: '100.00', total_tax: '21.00' }],
    fee_lines: [fee(1, 'EU Import Duty', '6.00', '1.26', 'duty_flat'), fee(2, 'EU Customs Fee', '4.00', '0.84', 'uhf')],
    shipping_lines: [{ total: '5.00', total_tax: '1.05' }],
  } as unknown as Pick<WcFullOrder, 'line_items' | 'fee_lines' | 'shipping_lines'>
  const reported = wcReportedOrderAmounts(order)
  assert.equal(reported.goodsNet.toString(), '110')
  assert.equal(reported.tax.toString(), '24.15')
  assert.equal(reported.shipping.toString(), '5')
  // net + tax + shipping = the WooCommerce order total (110 + 24.15 + 5 = 139.15 - the 5.00 shipping net is counted once).
  assert.equal(reported.goodsNet.add(reported.tax).add(reported.shipping).toString(), '139.15')
})

test('document-tax reconciliation: a taxed fee line at the destination rate reconciles, a mismatching one is named', () => {
  const lines = mapWcFeeLines([fee(1, 'EU Import Duty', '6.00', '1.26', 'duty_flat'), fee(2, 'EU Customs Fee', '4.00', '0.84', 'uhf')])
  const components = (rate: number) =>
    lines.map((l, i) => ({ label: l.description + i, netForeign: l.unitPriceForeign, rateValue: rate, reportedTaxForeign: l.taxForeign }))
  assert.equal(reconcileWcDocumentTax(components(0.21), 'EUR').reconciles, true)
  const wrong = reconcileWcDocumentTax(components(0.23), 'EUR')
  assert.equal(wrong.reconciles, false)
  assert.equal(wrong.disagreements.length, 2)
})

test('untaxed legacy fee still reconciles at rate 0 (forceNoTax lines carry rate 0)', () => {
  const [line] = mapWcFeeLines([{ id: 9, name: 'EU Import Duty', tax_class: '', total: '3.00', total_tax: '0.00', taxes: [] }])
  const rec = reconcileWcDocumentTax(
    [{ label: 'EU Import Duty', netForeign: line.unitPriceForeign, rateValue: 0, reportedTaxForeign: line.taxForeign }],
    'EUR',
  )
  assert.equal(rec.reconciles, true)
})
