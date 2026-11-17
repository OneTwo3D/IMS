/**
 * Mirror of WooCommerce's duty / tax results (owner decision D5: WooCommerce calculates, IMS mirrors, nothing is recomputed):
 * the IOSS number, the delivery term, the per-line customs value override, and the product tariff codes.
 * Pure readers: the value stored is the value WooCommerce holds, exactly; missing or unusable meta is null, never a guess.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as orderImportNs from '../../lib/connectors/woocommerce/sync/order-import.ts'
import * as shopNs from '../../lib/domain/accounting/shop-ioss-number.ts'
import * as dutyNs from '../../lib/connectors/woocommerce/sync/duty-tax-mirror.ts'
import * as hsNs from '../../lib/connectors/woocommerce/sync/hs-code-mirror.ts'

function unwrap<T extends object>(ns: T): T {
  return ('default' in ns ? (ns as { default: T }).default : ns) as T
}
const { readWcLineCustomsUnitValue } = unwrap(dutyNs)
const { parseShopIossNumber, iossFieldsFromRegime } = unwrap(shopNs)
const { wclcComponentColumns } = unwrap(orderImportNs)
const { readWcHsCodeMirror } = unwrap(hsNs)

const meta = (...pairs: Array<[string, unknown]>) => ({ meta_data: pairs.map(([key, value], id) => ({ id, key, value })) })

test('shop IOSS number: IM plus ten digits only (trimmed, upper-cased); anything else is not a number', () => {
  assert.equal(parseShopIossNumber(' im5280000001 '), 'IM5280000001')
  for (const bad of ['', null, undefined, 'IM123', 'IM52800000012', 'XX5280000001', 'IM 5280000001']) assert.equal(parseShopIossNumber(bad as never), null, String(bad))
})

test('order IOSS fields come from the EU VAT stamp: IOSS -> number + IOSS_DDP, DDP -> DDP, anything else null (DDU_DAP never inferred)', () => {
  assert.deepEqual(iossFieldsFromRegime('IOSS', 'IM5280000001'), { iossNumber: 'IM5280000001', deliveryTerm: 'IOSS_DDP' })
  assert.deepEqual(iossFieldsFromRegime('IOSS', null), { iossNumber: null, deliveryTerm: 'IOSS_DDP' }, 'no shop number set: no number, never invented')
  assert.deepEqual(iossFieldsFromRegime('DDP', 'IM5280000001'), { iossNumber: null, deliveryTerm: 'DDP' })
  for (const regime of ['VOEC', null, undefined, 'junk']) assert.deepEqual(iossFieldsFromRegime(regime as never, 'IM5280000001'), { iossNumber: null, deliveryTerm: null })
})

test('wclc components are mirrored as reported, never reconciled', () => {
  const odd = { meta_data: [{ id: 3, key: '_wclc_duty_component', value: '999.99' }, { id: 4, key: '_wclc_tax_component', value: '0.01' }] } as never
  assert.deepEqual(wclcComponentColumns(odd), { wclcDutyComponent: '999.99', wclcTaxComponent: '0.01', wclcHandlingComponent: null })
  assert.deepEqual(wclcComponentColumns({ meta_data: [] } as never), { wclcDutyComponent: null, wclcTaxComponent: null, wclcHandlingComponent: null })
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
