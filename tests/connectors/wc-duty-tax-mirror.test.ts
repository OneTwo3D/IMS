/**
 * Mirror of WooCommerce's duty / tax results (owner decision D5: WooCommerce calculates, IMS mirrors, nothing is recomputed):
 * the IOSS number, the delivery term, the per-line customs value override, and the product tariff codes.
 * Pure readers: the value stored is the value WooCommerce holds, exactly; missing or unusable meta is null, never a guess.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as fieldMappingNs from '../../lib/connectors/woocommerce/sync/field-mapping.ts'
import * as orderImportNs from '../../lib/connectors/woocommerce/sync/order-import.ts'
import * as hsNs from '../../lib/connectors/woocommerce/sync/hs-code-mirror.ts'

function unwrap<T extends object>(ns: T): T {
  return ('default' in ns ? (ns as { default: T }).default : ns) as T
}
const { readWcDutyTaxMirror, readWcLineCustomsUnitValue } = unwrap(fieldMappingNs)
const { dutyTaxMirrorColumns, wclcComponentColumns } = unwrap(orderImportNs)
const { readWcHsCodeMirror } = unwrap(hsNs)

const meta = (...pairs: Array<[string, unknown]>) => ({ meta_data: pairs.map(([key, value], id) => ({ id, key, value })) })

test('IOSS number and delivery term are mirrored exactly as WooCommerce holds them', () => {
  assert.deepEqual(readWcDutyTaxMirror(meta(['_o3d_ioss_number', 'IM5280000001'], ['_o3d_delivery_term', 'IOSS_DDP'])), { iossNumber: 'IM5280000001', deliveryTerm: 'IOSS_DDP' })
  for (const term of ['IOSS_DDP', 'DDP', 'DDU_DAP']) assert.equal(readWcDutyTaxMirror(meta(['_o3d_delivery_term', term]))!.deliveryTerm, term)
})

test('missing, blank or unusable meta leaves the fields null (never defaulted or derived)', () => {
  assert.deepEqual(readWcDutyTaxMirror(meta()), { iossNumber: null, deliveryTerm: null })
  assert.deepEqual(readWcDutyTaxMirror(meta(['_o3d_ioss_number', '  '], ['_o3d_delivery_term', ''])), { iossNumber: null, deliveryTerm: null })
  assert.deepEqual(readWcDutyTaxMirror(meta(['_o3d_ioss_number', 'has space'], ['_o3d_delivery_term', 'FOB'])), { iossNumber: null, deliveryTerm: null })
  assert.deepEqual(readWcDutyTaxMirror(meta(['_o3d_ioss_number', { n: 1 }], ['_o3d_delivery_term', 7])), { iossNumber: null, deliveryTerm: null })
  // No meta list at all is "WooCommerce said nothing": no mirror (an update leaves the stored values alone), not a pair of nulls.
  assert.equal(readWcDutyTaxMirror({} as never), null)
})

test('order columns: create writes null for missing meta; update with no meta list writes nothing, with a list follows it (a removed value clears)', () => {
  const full = { meta_data: [{ id: 1, key: '_o3d_ioss_number', value: 'IM1' }, { id: 2, key: '_wclc_duty_component', value: '3.10' }] } as never
  assert.deepEqual(dutyTaxMirrorColumns(full, 'create'), { iossNumber: 'IM1', deliveryTerm: null })
  assert.deepEqual(dutyTaxMirrorColumns({} as never, 'create'), { iossNumber: null, deliveryTerm: null })
  assert.deepEqual(dutyTaxMirrorColumns({} as never, 'update'), {})
  assert.deepEqual(dutyTaxMirrorColumns({ meta_data: [] } as never, 'update'), { iossNumber: null, deliveryTerm: null })
  assert.deepEqual(wclcComponentColumns(full), { wclcDutyComponent: '3.10', wclcTaxComponent: null, wclcHandlingComponent: null })
})

test('nothing is recomputed: values that disagree with each other and with the order are stored as reported', () => {
  // A DDU_DAP order that also reports a duty component and an IOSS number: IMS neither reconciles nor "corrects" any of it.
  const odd = { currency: 'GBP', total: '10.00', billing: { country: 'GB' }, fee_lines: [], meta_data: [
    { id: 1, key: '_o3d_ioss_number', value: 'IM0000000000' }, { id: 2, key: '_o3d_delivery_term', value: 'DDU_DAP' },
    { id: 3, key: '_wclc_duty_component', value: '999.99' }, { id: 4, key: '_wclc_tax_component', value: '0.01' },
  ] } as never
  assert.deepEqual({ ...dutyTaxMirrorColumns(odd, 'create'), ...wclcComponentColumns(odd) }, {
    iossNumber: 'IM0000000000', deliveryTerm: 'DDU_DAP', wclcDutyComponent: '999.99', wclcTaxComponent: '0.01', wclcHandlingComponent: null,
  })
})

test('line customs value override: the WooCommerce value, exactly; absent / zero / junk is null', () => {
  const line = (...pairs: Array<[string, unknown]>) => ({ meta_data: pairs.map(([key, value], id) => ({ id, key, value })) })
  assert.equal(readWcLineCustomsUnitValue(line(['_wc_label_customs_unit_value', '12.50'])), '12.50')
  assert.equal(readWcLineCustomsUnitValue(line(['_wc_label_customs_unit_value', '2.925'])), '2.925', 'not rounded')
  assert.equal(readWcLineCustomsUnitValue(line(['_wc_label_customs_unit_value', 7])), '7')
  assert.equal(readWcLineCustomsUnitValue(line()), null)
  assert.equal(readWcLineCustomsUnitValue({} as never), null)
  for (const bad of ['', '0', '0.00', '-1', '1e2', '1,5', 'abc', ' ', null]) assert.equal(readWcLineCustomsUnitValue(line(['_wc_label_customs_unit_value', bad])), null, String(bad))
})

test('product tariff codes: pa_us_hs_code and _dutify_hs_codes are mirrored; the IMS-owned hsCode is not touched', () => {
  const product = {
    attributes: [
      { id: 1, name: 'HS Code', slug: 'pa_hs_code', position: 0, visible: true, variation: false, options: ['39219090'] },
      { id: 2, name: 'US HS Code', slug: 'pa_us_hs_code', position: 1, visible: true, variation: false, options: ['3921905050'] },
    ],
    meta_data: [{ id: 9, key: '_dutify_hs_codes', value: { US: { code: '3921905050', hash: 'abc', at: 1785498771.393, source: 'dutify_landed_cost' }, ca: { code: '3921.90.90' }, XXX: { code: '1' }, DE: { code: 'junk' } } }],
  }
  const mirror = readWcHsCodeMirror(product as never)
  assert.deepEqual(mirror, { wcUsHsCode: '3921905050', wcDutifyHsCodes: { US: '3921905050', CA: '3921.90.90' } })
  assert.equal('hsCode' in mirror, false, 'the IMS-owned hsCode is never part of the mirror')
})

test('product tariff codes: missing data is null (clears on edit); an absent list leaves the column alone', () => {
  const none = { attributes: [{ id: 1, name: 'HS Code', slug: 'pa_hs_code', position: 0, visible: true, variation: false, options: ['39219090'] }], meta_data: [] }
  assert.deepEqual(readWcHsCodeMirror(none as never), { wcUsHsCode: null, wcDutifyHsCodes: null })
  assert.deepEqual(readWcHsCodeMirror({} as never), {}, 'no attributes / meta_data in the payload: undefined, so the update leaves both columns alone')
  assert.deepEqual(readWcHsCodeMirror({ attributes: [], meta_data: [{ id: 1, key: '_dutify_hs_codes', value: 'a:0:{}' }] } as never), { wcUsHsCode: null, wcDutifyHsCodes: null })
})
