import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { resolveEuVatRegime } from '@/lib/domain/accounting/eu-vat-regime'
import {
  buildEuVatRegimeInput, loadRateMappings, readPluginFx, readEasFact, readGoodsLines, readRateTax, readVatRecord, readWcEuVatFacts, resolveThresholdFx, type EuVatRegimeInputClient,
} from '@/lib/connectors/woocommerce/sync/eu-vat-facts'
import type { WcFullOrder, WcMeta } from '@/lib/connectors/woocommerce/sync/types'

const meta = (key: string, value: unknown): WcMeta => ({ id: 1, key, value })

function wcOrder(over: Partial<WcFullOrder> = {}): WcFullOrder {
  return {
    id: 1, number: '1', currency: 'EUR', date_created: '2026-11-01T10:00:00', date_created_gmt: '2026-11-01T10:00:00', total: '119.00', total_tax: '19.00',
    billing: { country: 'DE' }, shipping: { country: 'DE' },
    meta_data: [],
    line_items: [{ id: 1, total: '100.00', meta_data: [] }],
    tax_lines: [{ id: 1, rate_id: 216, rate_code: 'x', label: 'DE', compound: false, tax_total: '17.00', shipping_tax_total: '2.00' }],
    shipping_lines: [], fee_lines: [], coupon_lines: [], refunds: [],
    ...over,
  } as unknown as WcFullOrder
}

test('the destination is read as shipping, else billing; blanks are absent', () => {
  assert.deepEqual([readWcEuVatFacts(wcOrder()).shippingCountry, readWcEuVatFacts(wcOrder()).billingCountry], ['DE', 'DE'])
  const blank = readWcEuVatFacts(wcOrder({ shipping: { country: '  ' } as never }))
  assert.equal(blank.shippingCountry, null)
  assert.equal(blank.billingCountry, 'DE')
})

test('tax per rate id sums items, fees and shipping, and merges repeated ids', () => {
  const order = wcOrder({
    tax_lines: [
      { id: 1, rate_id: 216, tax_total: '17.00', shipping_tax_total: '2.00' },
      { id: 2, rate_id: 216, tax_total: '1.50', shipping_tax_total: '0.00' },
      { id: 3, rate_id: 182, tax_total: '0.00', shipping_tax_total: '0.00' },
    ] as never,
  })
  assert.deepEqual(readRateTax(order), [{ wooRateId: 182, tax: '0' }, { wooRateId: 216, tax: '20.5' }])
})

test('gift-card detection: only a line carrying the flag is a gift card; an unflagged line is goods (the product-level marker is not on the order)', () => {
  const lines = readGoodsLines(wcOrder({
    line_items: [
      { id: 1, total: '10.00', meta_data: [meta('_o3d_is_voucher', 'yes')] },
      { id: 2, total: '20.00', meta_data: [meta('_o3d_is_voucher', 'no')] },
      { id: 3, total: '30.00', meta_data: [meta('_o3d_is_voucher', '')] },
      { id: 4, total: '40.00', meta_data: [] },
      { id: 5, total: 'junk', meta_data: [] },
    ] as never,
  }))
  assert.deepEqual(lines, [
    { total: '10.00', voucher: true }, { total: '20.00', voucher: false }, { total: '30.00', voucher: false }, { total: '40.00', voucher: false }, { total: '0', voucher: false },
  ])
})

test('the B2B exemption flag: yes, 1 and true are exempt; no, absent and junk are not', () => {
  const exempt = (value: unknown | undefined) => readWcEuVatFacts(wcOrder({ meta_data: value === undefined ? [] : [meta('is_vat_exempt', value)] })).vatExempt
  assert.deepEqual([exempt('yes'), exempt('1'), exempt(true), exempt('no'), exempt(undefined), exempt('maybe'), exempt('')], [true, true, true, false, false, false, false])
})

test('the EU VAT record: present when readable with rates and a total; empty, unreadable or absent reads as absent', () => {
  const record = (value: unknown) => readVatRecord(wcOrder({ meta_data: [meta('vat_compliance_vat_paid', value)] }))
  assert.deepEqual(record({ currency: 'eur', total: 19, by_rates: { 216: { rate: 19 } } }), { state: 'present', currency: 'EUR', total: '19' })
  assert.deepEqual(record(JSON.stringify({ currency: 'EUR', total: '19.00', by_rates: [{ rate: 19 }] })), { state: 'present', currency: 'EUR', total: '19.00' })
  assert.deepEqual(record({ currency: 'EUR', total: '19.00', by_rates: {} }), { state: 'absent' })
  assert.deepEqual(record({ currency: 'EUR', by_rates: { 216: {} } }), { state: 'absent' })
  assert.deepEqual(record('not json'), { state: 'absent' })
  assert.deepEqual(record([1, 2]), { state: 'absent' })
  assert.deepEqual(readVatRecord(wcOrder()), { state: 'absent' })
  assert.deepEqual(record({ total: '19', by_rates: { 216: {} } }), { state: 'present', currency: null, total: '19' })
})

test("the plugin's conversion record: rate and pair must both be readable; the threshold value is carried when readable", () => {
  const fx = (entries: Array<[string, unknown]>) => readPluginFx(wcOrder({ meta_data: entries.map(([k, v]) => meta(k, v)) }))
  assert.deepEqual(fx([['_o3d_ioss_fx_rate', '1.1534'], ['_o3d_ioss_fx_pair', 'gbp>eur'], ['_o3d_ioss_threshold_value', '149.50']]), { state: 'present', rate: '1.1534', pair: 'GBP>EUR', thresholdValue: '149.50' })
  assert.deepEqual(fx([['_o3d_ioss_fx_rate', 1.15], ['_o3d_ioss_fx_pair', 'GBP>EUR']]), { state: 'present', rate: '1.15', pair: 'GBP>EUR', thresholdValue: null })
  assert.deepEqual(fx([['_o3d_ioss_fx_rate', '1.15']]), { state: 'absent' })
  assert.deepEqual(fx([['_o3d_ioss_fx_pair', 'GBP>EUR']]), { state: 'absent' })
  assert.deepEqual(fx([['_o3d_ioss_fx_rate', '0'], ['_o3d_ioss_fx_pair', 'GBP>EUR']]), { state: 'absent' })
  assert.deepEqual(fx([['_o3d_ioss_fx_rate', '1.15'], ['_o3d_ioss_fx_pair', 'GBPEUR']]), { state: 'absent' })
  assert.deepEqual(readWcEuVatFacts(wcOrder()).pluginFx, { state: 'absent' })
})

test('the EAS figure: needs a readable merchandise value', () => {
  const eas = (value: unknown) => readEasFact(wcOrder({ meta_data: [meta('easproj_payload', value)] }))
  assert.deepEqual(eas({ merchandise_cost_vat_excl: '100.00', payment_currency: 'EUR' }), { state: 'present', merchandiseVatExcl: '100.00', currency: 'EUR' })
  assert.deepEqual(eas({ merchandise_cost_vat_excl: 'x' }), { state: 'absent' })
  assert.deepEqual(eas('garbage'), { state: 'absent' })
  assert.deepEqual(readEasFact(wcOrder()), { state: 'absent' })
})

test("the plugin's recorded VAT account, and the over-threshold duty fee from the fee kind (not from a label)", () => {
  assert.equal(readWcEuVatFacts(wcOrder({ meta_data: [meta('_o3d_ioss_vat_account', ' 232 ')] })).pluginVatAccount, '232')
  assert.equal(readWcEuVatFacts(wcOrder({ meta_data: [meta('_o3d_ioss_vat_account', '')] })).pluginVatAccount, null)
  const fee = (name: string, total: string, kind: string | null) => ({ id: 1, name, total, total_tax: '0', meta_data: kind === null ? [] : [meta('_wclc_fee', '1'), meta('_wclc_fee_kind', kind)] })
  const facts = (fees: unknown[]) => readWcEuVatFacts(wcOrder({ fee_lines: fees as never })).overThresholdDutyFee
  assert.equal(facts([fee('Import Duty', '14.75', 'duty_fee')]), true)
  assert.equal(facts([fee('Import Duty', '0', 'duty_fee')]), false)
  assert.equal(facts([fee('EU Customs Fee', '2', 'uhf'), fee('EU Import Duty', '3', 'duty_flat')]), false)
  assert.equal(facts([fee('Import Duty', '14.75', null)]), false)
})

// ---- the database halves, against fakes ---------------------------------------------------------------------------------------------------------------------------------
function fakeClient(over: { mappings?: unknown[]; fxRows?: Array<{ toCurrency: string; rate: string }>; base?: string } = {}): EuVatRegimeInputClient {
  const fetchedAt = new Date('2026-10-31T12:00:00Z')
  const rows = (over.fxRows ?? []).map((row, i) => ({ fromCurrency: over.base ?? 'GBP', toCurrency: row.toCurrency, rate: new Prisma.Decimal(row.rate), fetchedAt, source: 'aelia', manualOverride: false, seq: BigInt(i + 1) }))
  return {
    shoppingTaxRateMapping: { findMany: (async () => over.mappings ?? []) as never },
    fxRate: {
      groupBy: (async (args: { where: { toCurrency: { in: string[] } } }) => rows.filter((r) => args.where.toCurrency.in.includes(r.toCurrency)).map((r) => ({ toCurrency: r.toCurrency, _max: { fetchedAt } }))) as never,
      findMany: (async () => rows) as never,
    },
    setting: { findMany: (async () => []) as never },
  }
}
const mappingRow = (id: number, taxRate: Record<string, unknown>) => ({
  externalTaxRateId: String(id),
  taxRate: { id: `ims-${id}`, name: 'DE VAT', rate: new Prisma.Decimal('0.19'), active: true, countryCode: 'de', reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131', ...taxRate },
})

test('rate mappings are loaded by id: a row maps, no row is unmapped, the country is normalised', async () => {
  const map = await loadRateMappings(fakeClient({ mappings: [mappingRow(216, { countryCode: 'uk' })] }), [216, 999])
  assert.deepEqual(map.get(999), { state: 'unmapped' })
  assert.deepEqual(map.get(216), {
    state: 'mapped', imsRateId: 'ims-216', name: 'DE VAT', active: true, countryCode: 'GB', rate: '0.19', reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131',
  })
  assert.equal((await loadRateMappings(fakeClient(), [])).size, 0)
})

test('threshold FX: same currency needs no rate; otherwise order currency to EUR (or NOK) through the base at the order date', async () => {
  const at = new Date('2026-11-01T10:00:00Z')
  assert.deepEqual(await resolveThresholdFx(fakeClient(), { currency: 'EUR', destination: 'DE', orderedAt: at, baseCurrency: 'GBP' }), { state: 'ok', rate: '1', sameCurrency: true, asOf: at.toISOString(), source: 'same currency' })
  assert.equal((await resolveThresholdFx(fakeClient(), { currency: 'NOK', destination: 'NO', orderedAt: at, baseCurrency: 'GBP' })).state, 'ok')
  // 1 GBP = 1.25 USD = 1.15 EUR: one USD is 0.92 EUR.
  const usd = await resolveThresholdFx(fakeClient({ fxRows: [{ toCurrency: 'USD', rate: '1.25' }, { toCurrency: 'EUR', rate: '1.15' }] }), { currency: 'USD', destination: 'DE', orderedAt: at, baseCurrency: 'GBP' })
  assert.equal(usd.state, 'ok')
  assert.equal(usd.state === 'ok' && Number(usd.rate).toFixed(4), '0.9200')
  // The base currency is one: 1 GBP = 1.15 EUR.
  const gbp = await resolveThresholdFx(fakeClient({ fxRows: [{ toCurrency: 'EUR', rate: '1.15' }] }), { currency: 'GBP', destination: 'DE', orderedAt: at, baseCurrency: 'GBP' })
  assert.equal(gbp.state === 'ok' && gbp.rate, '1.15')
  // Norway converts to NOK.
  const toNok = await resolveThresholdFx(fakeClient({ fxRows: [{ toCurrency: 'NOK', rate: '13.4' }] }), { currency: 'GBP', destination: 'NO', orderedAt: at, baseCurrency: 'GBP' })
  assert.equal(toNok.state === 'ok' && toNok.rate, '13.4')
})

test('threshold FX: a missing rate is unavailable, never defaulted, and the resolver refuses on it', async () => {
  const at = new Date('2026-11-01T10:00:00Z')
  const missing = await resolveThresholdFx(fakeClient({ fxRows: [{ toCurrency: 'USD', rate: '1.25' }] }), { currency: 'USD', destination: 'DE', orderedAt: at, baseCurrency: 'GBP' })
  assert.equal(missing.state, 'unavailable')
  const input = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), wcOrder({ currency: 'USD' }), { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide' })
  assert.equal(input.thresholdFx.state, 'unavailable')
  const decision = resolveEuVatRegime(input)
  assert.equal(decision.kind === 'REFUSE' && decision.code, 'threshold_value_unavailable')
})

test('a whole order reads into a decision: DE, EUR 100 plus 19 VAT on the mapped scheme rate is IOSS on 821', async () => {
  const input = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), wcOrder(), { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide' })
  assert.deepEqual(input.rates, [{ wooRateId: 216, tax: '19', mapping: await loadRateMappings(fakeClient({ mappings: [mappingRow(216, {})] }), [216]).then((m) => m.get(216)!) }])
  const decision = resolveEuVatRegime(input)
  assert.equal(decision.kind, 'SCHEME')
  assert.equal(decision.kind === 'SCHEME' && decision.regime, 'IOSS')
  assert.equal(decision.kind === 'SCHEME' && decision.vatAccount, '821')
})

test('an order with no creation date cannot be valued: the threshold fact is unavailable', async () => {
  const input = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), wcOrder({ date_created_gmt: '', date_created: 'not a date' }), { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP' })
  assert.equal(input.thresholdFx.state, 'unavailable')
})

test('adopt mode end to end (the default): the plugin account decides and its conversion record lands in the basis', async () => {
  const withMeta = wcOrder({ meta_data: [meta('_o3d_ioss_vat_account', '232'), meta('_o3d_ioss_fx_rate', '1.15'), meta('_o3d_ioss_fx_pair', 'EUR>EUR'), meta('_o3d_ioss_threshold_value', '100')] })
  const input = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), withMeta, { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP' })
  assert.equal(input.mode, 'adopt_plugin')
  const d = resolveEuVatRegime(input)
  assert.equal(d.kind === 'SCHEME' && d.regime, 'DDP')
  assert.equal(d.kind === 'SCHEME' && d.basis.pluginFx?.rate, '1.15')
  // the same order without the account refuses; in decide mode it decides by value
  const bare = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), wcOrder(), { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP' })
  assert.equal(resolveEuVatRegime(bare).kind === 'REFUSE' && (resolveEuVatRegime(bare) as { code: string }).code, 'plugin_account_missing')
  const decide = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), wcOrder(), { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide' })
  assert.equal(decide.mode, 'decide')
  assert.equal(resolveEuVatRegime(decide).kind === 'SCHEME' && (resolveEuVatRegime(decide) as { regime: string }).regime, 'IOSS')
})
