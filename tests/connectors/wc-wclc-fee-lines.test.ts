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
import * as xeroInvoicesNs from '../../lib/connectors/xero/invoices.ts'
import * as orderImportNs from '../../lib/connectors/woocommerce/sync/order-import.ts'
import type { WcFeeLine, WcFullOrder } from '../../lib/connectors/woocommerce/sync/types.ts'

type Mod<T> = T
function unwrap<T extends object>(ns: T): Mod<T> {
  return ('default' in ns ? (ns as { default: T }).default : ns) as T
}
const { mapWcFeeLines, readWclcFeeKind } = unwrap(fieldMappingNs)
const { wcReportedOrderAmounts } = unwrap(couponNs)
const { reconcileWcDocumentTax, resolveWcLineAccountingTaxType } = unwrap(orderImportNs)
const { buildSalesInvoicePayload } = unwrap(xeroInvoicesNs)

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
    isFeeLine: true,
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

// --- order-level components (persisted as nullable columns) ---------------------------------------
const { readWclcOrderComponents } = unwrap(fieldMappingNs)
const orderMeta = (...pairs: Array<[string, unknown]>) => ({ meta_data: pairs.map(([key, value], id) => ({ id, key, value })) })

test('order components: duty, import VAT and handling are mirrored as reported', () => {
  assert.deepEqual(
    readWclcOrderComponents(orderMeta(['_wclc_duty_component', '12.50'], ['_wclc_tax_component', '40.38'], ['_wclc_handling_component', '2.00'])),
    { dutyComponent: '12.50', taxComponent: '40.38', handlingComponent: '2.00' },
  )
  assert.deepEqual(
    readWclcOrderComponents(orderMeta(['_wclc_duty_component', 3], ['_wclc_tax_component', '0'])),
    { dutyComponent: '3', taxComponent: '0', handlingComponent: null },
  )
})

test('order components: handling is absent unless above zero; junk, negatives and a missing key read as null', () => {
  assert.equal(readWclcOrderComponents(orderMeta(['_wclc_handling_component', '0'])).handlingComponent, null)
  assert.equal(readWclcOrderComponents(orderMeta(['_wclc_handling_component', '0.00'])).handlingComponent, null)
  assert.equal(readWclcOrderComponents(orderMeta(['_wclc_duty_component', '-1'])).dutyComponent, null)
  assert.equal(readWclcOrderComponents(orderMeta(['_wclc_duty_component', 'abc'])).dutyComponent, null)
  assert.equal(readWclcOrderComponents(orderMeta(['_wclc_duty_component', ''])).dutyComponent, null)
  assert.deepEqual(readWclcOrderComponents({ meta_data: [] }), { dutyComponent: null, taxComponent: null, handlingComponent: null })
})

// --- the ACCOUNTING payload: untaxed fee lines must not fall through to the order default tax code ---------------------

const OUTPUT_IOSS = 'OUTPUT2' // the taxable order-default code on an EU order
const XERO_RATE: Record<string, number> = { OUTPUT2: 0.21, NONE: 0 }
const penny = (v: number) => Math.round(v * 100) / 100

type XeroLine = { Quantity?: number; UnitAmount?: number; DiscountAmount?: number; TaxType?: string; Description?: string }

/** What Xero makes of the payload: each line's net plus net x the rate of the code it was sent on. */
function xeroTotal(payload: Record<string, unknown>): number {
  assert.equal(payload.LineAmountTypes, 'Exclusive')
  return penny((payload.LineItems as XeroLine[]).reduce((sum, l) => {
    const net = penny((l.Quantity ?? 0) * (l.UnitAmount ?? 0) - (l.DiscountAmount ?? 0))
    return sum + net + penny(net * (XERO_RATE[l.TaxType ?? ''] ?? 0))
  }, 0))
}

/** The import's per-line step: mapped WooCommerce lines -> accounting lines, the way order-import builds them. */
function accountingLines(fees: WcFeeLine[], usePatchedResolution: boolean) {
  const mapped = mapWcFeeLines(fees)
  const goodsLine = { description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', taxType: OUTPUT_IOSS }
  const feeLines = mapped.map((l) => {
    // Taxed fee: its own WooCommerce rate id resolves to the mapped IOSS code. No-tax fee: resolution yields no code.
    const base = l.forceNoTax ? undefined : OUTPUT_IOSS
    const taxType = usePatchedResolution
      ? resolveWcLineAccountingTaxType({ forceNoTax: l.forceNoTax, baseTaxType: base, reverseCharge: false, reverseChargeSalesTaxType: '' })
      : (base ?? OUTPUT_IOSS) // the old behaviour: a missing code falls through to the order default
    return { description: l.description, quantity: 1, unitAmount: l.unitPriceForeign, accountCode: '260', taxType }
  })
  return [goodsLine, ...feeLines]
}

function invoice(lines: ReturnType<typeof accountingLines>) {
  return buildSalesInvoicePayload(
    { invoiceNumber: 'WC-1', contactName: 'A Customer', date: '2026-11-02', currency: 'EUR', lines },
    'AUTHORISED', 'contact-1', new Set<string>(), 'EUR',
  )
}

test('accounting payload: taxed EU fees keep the IOSS code, untaxed fees go on NONE, and the total equals WooCommerce\'s', () => {
  const fees = [
    fee(1, 'EU Import Duty', '6.00', '1.26', 'duty_flat'),               // taxed
    fee(2, 'EU Customs Fee', '4.00', '0.84', 'uhf'),                      // taxed
    fee(3, 'Import Duty', '53.40', '0.00', 'duty_fee', null),             // >EUR 150 non-taxable line
    { id: 4, name: 'EU Duty', tax_class: '', total: '3.00', total_tax: '0.00', taxes: [] } as WcFeeLine, // legacy untaxed fee
  ]
  // WooCommerce: goods 100 + 21.00, fees 6 + 1.26, 4 + 0.84, 53.40, 3.00 = 189.50.
  const wooTotal = penny(100 + 21 + 6 + 1.26 + 4 + 0.84 + 53.4 + 3)
  assert.equal(wooTotal, 189.5)

  const patched = invoice(accountingLines(fees, true))
  const types = (patched.LineItems as XeroLine[]).map((l) => `${l.Description}=${l.TaxType}`)
  assert.deepEqual(types, ['Widget=OUTPUT2', 'EU Import Duty=OUTPUT2', 'EU Customs Fee=OUTPUT2', 'Import Duty=NONE', 'EU Duty=NONE'])
  assert.equal(xeroTotal(patched), wooTotal)

  // The control: the old fall-through taxes the two untaxed fees at the IOSS rate and the total is wrong by their VAT.
  const old = invoice(accountingLines(fees, false))
  assert.equal(xeroTotal(old), penny(wooTotal + penny(53.4 * 0.21) + penny(3 * 0.21)))
  assert.notEqual(xeroTotal(old), wooTotal)
})

test('resolveWcLineAccountingTaxType: forceNoTax is NONE whatever the base; otherwise the normal resolution (incl. reverse charge)', () => {
  const base = { baseTaxType: 'OUTPUT2', reverseCharge: false, reverseChargeSalesTaxType: 'ECOUTPUT' }
  assert.equal(resolveWcLineAccountingTaxType({ ...base, forceNoTax: true }), 'NONE')
  assert.equal(resolveWcLineAccountingTaxType({ ...base, baseTaxType: undefined, forceNoTax: true }), 'NONE')
  assert.equal(resolveWcLineAccountingTaxType({ ...base, forceNoTax: false }), 'OUTPUT2')
  assert.equal(resolveWcLineAccountingTaxType({ ...base, forceNoTax: undefined, reverseCharge: true }), 'ECOUTPUT')
})

// --- scope: the explicit no-tax accounting code is for FEE lines only ----------------------------------------------------

const { mapWcLineItems } = unwrap(fieldMappingNs)

test('fee lines are marked isFeeLine; goods lines never are, and carry no forceNoTax', async () => {
  const [feeLine] = mapWcFeeLines([{ id: 9, name: 'EU Duty', tax_class: '', total: '3.00', total_tax: '0.00', taxes: [] }])
  assert.equal(feeLine.isFeeLine, true)
  assert.equal(feeLine.forceNoTax, true)
  // A no-rate goods line (no SKU, so no database lookup): unchanged vs development - no forceNoTax, not a fee.
  const [goods] = await mapWcLineItems([
    { id: 1, name: 'Gift card', product_id: 5, variation_id: 0, quantity: 1, tax_class: '', subtotal: '25.00', subtotal_tax: '0.00', total: '25.00', total_tax: '0.00', sku: '', price: 25, taxes: [], meta_data: [] } as never,
  ], 1)
  assert.equal(goods.forceNoTax, undefined)
  assert.equal(goods.isFeeLine, undefined)
  // The accounting code of such a line is the normal resolution (the order default when it has no code), exactly as on development.
  assert.equal(
    resolveWcLineAccountingTaxType({ forceNoTax: goods.isFeeLine === true ? goods.forceNoTax : undefined, baseTaxType: 'OUTPUT2', reverseCharge: false, reverseChargeSalesTaxType: '' }),
    'OUTPUT2',
  )
  assert.equal(
    resolveWcLineAccountingTaxType({ forceNoTax: undefined, baseTaxType: undefined, reverseCharge: false, reverseChargeSalesTaxType: '' }),
    undefined,
  )
})
