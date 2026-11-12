import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { resolveEuVatRegime } from '@/lib/domain/accounting/eu-vat-regime'
import {
  buildEuVatRegimeInput, giftCardFlagPolicy, loadRateMappings, readPluginFx, readEasFact, readGoodsLines, readRateTax, readVatRecord, readWcEuVatFacts, resolveThresholdFx, type EuVatRegimeInputClient,
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

test('gift-card detection: yes and no are read from the line; a line with no flag is unknown (the product-level marker is not on the order)', () => {
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
    { total: '10.00', voucher: 'yes' }, { total: '20.00', voucher: 'no' }, { total: '30.00', voucher: 'no' }, { total: '40.00', voucher: 'unknown' }, { total: '0', voucher: 'unknown' },
  ])
})

test('the B2B exemption flag: yes, 1 and true are exempt; no, 0, false and blank are not; absent or junk is unknown', () => {
  const exempt = (value: unknown | undefined) => readWcEuVatFacts(wcOrder({ meta_data: value === undefined ? [] : [meta('is_vat_exempt', value)] })).vatExempt
  assert.deepEqual([exempt('yes'), exempt('1'), exempt(true), exempt('no'), exempt('0'), exempt(false), exempt(''), exempt(undefined), exempt('maybe'), exempt({})], ['yes', 'yes', 'yes', 'no', 'no', 'no', 'no', 'unknown', 'unknown', 'unknown'])
})

test('the EU VAT record: present when readable; empty is absent; non-empty but unreadable is unreadable', () => {
  const record = (value: unknown) => readVatRecord(wcOrder({ meta_data: [meta('vat_compliance_vat_paid', value)] }))
  assert.deepEqual(record({ currency: 'eur', total: 19, by_rates: { 216: { rate: 19 } } }), { state: 'present', currency: 'EUR', total: '19' })
  assert.deepEqual(record(JSON.stringify({ currency: 'EUR', total: '19.00', by_rates: [{ rate: 19 }] })), { state: 'present', currency: 'EUR', total: '19.00' })
  assert.deepEqual(record({ total: '19', by_rates: { 216: {} } }), { state: 'present', currency: null, total: '19' })
  // empty is absent: nothing, blank text, an empty list or object, or a record with no rates
  for (const empty of [undefined, null, '', '  ', [], {}, '[]', '{}', { currency: 'EUR', total: '19.00', by_rates: {} }, { currency: 'EUR', total: '19.00', by_rates: [] }, { currency: 'EUR' }]) {
    assert.deepEqual(record(empty), { state: 'absent' }, JSON.stringify(empty))
  }
  assert.deepEqual(readVatRecord(wcOrder()), { state: 'absent' })
  // non-empty and unreadable
  for (const [bad, detail] of [
    [{ currency: 'EUR', by_rates: { 216: {} } }, 'total is missing or not a number'],
    [{ currency: 'EUR', total: 'n/a', by_rates: { 216: {} } }, 'total is missing or not a number'],
    [{ currency: 'EUR', total: '1,5', by_rates: { 216: {} } }, 'total is missing or not a number'],
    [{ currency: 'EURO', total: '19', by_rates: { 216: {} } }, 'currency is not a three-letter code'],
    [{ currency: 'EUR', total: '19', by_rates: 'x' }, 'by_rates is not a list'],
    ['not json', 'not JSON'],
    [[1, 2], 'not an object'],
    [42, 'not an object'],
  ] as Array<[unknown, string]>) {
    assert.deepEqual(record(bad), { state: 'unreadable', detail }, JSON.stringify(bad))
  }
})

test("the plugin's conversion record: all three readable is present, none is absent, anything between is incomplete", () => {
  const fx = (entries: Array<[string, unknown]>) => readPluginFx(wcOrder({ meta_data: entries.map(([k, v]) => meta(k, v)) }))
  const full: Array<[string, unknown]> = [['_o3d_ioss_fx_rate', '1.1534'], ['_o3d_ioss_fx_pair', 'gbp>eur'], ['_o3d_ioss_threshold_value', '149.50']]
  assert.deepEqual(fx(full), { state: 'present', rate: '1.1534', pair: 'GBP>EUR', thresholdValue: '149.50' })
  assert.deepEqual(fx([['_o3d_ioss_fx_rate', 1.15], ['_o3d_ioss_fx_pair', 'EUR>EUR'], ['_o3d_ioss_threshold_value', '100.00']]), { state: 'present', rate: '1.15', pair: 'EUR>EUR', thresholdValue: '100.00' })
  assert.deepEqual(fx([]), { state: 'absent' })
  assert.deepEqual(fx([['_o3d_ioss_fx_rate', ''], ['_o3d_ioss_fx_pair', '']]), { state: 'absent' })
  for (const drop of [0, 1, 2]) assert.equal(fx(full.filter((_, i) => i !== drop)).state, 'incomplete', `missing ${full[drop]![0]}`)
  assert.equal(fx([['_o3d_ioss_fx_rate', '1.15']]).state, 'incomplete')
  assert.equal(fx([full[0]!, full[1]!, ['_o3d_ioss_threshold_value', 'abc']]).state, 'incomplete')
  assert.equal(fx([['_o3d_ioss_fx_rate', '0'], full[1]!, full[2]!]).state, 'incomplete')
  assert.equal(fx([full[0]!, ['_o3d_ioss_fx_pair', 'GBPEUR'], full[2]!]).state, 'incomplete')
  assert.deepEqual(readWcEuVatFacts(wcOrder()).pluginFx, { state: 'absent' })
})

test("the plugin's FX-conflict marker in _o3d_ioss_reason", () => {
  const conflict = (reason: unknown) => readWcEuVatFacts(wcOrder({ meta_data: reason === undefined ? [] : [meta('_o3d_ioss_reason', reason)] })).pluginFxConflict
  assert.equal(conflict('IOSS by value. [FX meta already present and different from this decision; left unchanged: {"rate":"1.1"}]'), true)
  assert.equal(conflict('IOSS by value'), false)
  assert.equal(conflict(undefined), false)
  assert.equal(conflict(42), false)
})

test('the EAS figure: needs a readable merchandise value; empty is absent; garbage is unreadable', () => {
  const eas = (value: unknown) => readEasFact(wcOrder({ meta_data: [meta('easproj_payload', value)] }))
  assert.deepEqual(eas({ merchandise_cost_vat_excl: '100.00', payment_currency: 'EUR' }), { state: 'present', merchandiseVatExcl: '100.00', currency: 'EUR' })
  assert.deepEqual(eas({ merchandise_cost_vat_excl: '100.00' }), { state: 'present', merchandiseVatExcl: '100.00', currency: null })
  for (const empty of [undefined, '', {}, [], { other: 1 }, { merchandise_cost_vat_excl: '' }]) assert.deepEqual(eas(empty), { state: 'absent' }, JSON.stringify(empty))
  assert.deepEqual(eas({ merchandise_cost_vat_excl: 'x' }), { state: 'unreadable', detail: 'merchandise_cost_vat_excl is not a number' })
  assert.deepEqual(eas({ merchandise_cost_vat_excl: '1', payment_currency: 'EURO' }), { state: 'unreadable', detail: 'payment_currency is not a three-letter code' })
  assert.deepEqual(eas('garbage'), { state: 'unreadable', detail: 'not JSON' })
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
  const withMeta = wcOrder({ line_items: [{ id: 1, total: '200.00', meta_data: [] }] as never, meta_data: [meta('_o3d_ioss_vat_account', '232'), meta('_o3d_ioss_fx_rate', '1'), meta('_o3d_ioss_fx_pair', 'EUR>EUR'), meta('_o3d_ioss_threshold_value', '200.00')] })
  const input = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), withMeta, { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP' })
  assert.equal(input.mode, 'adopt_plugin')
  const d = resolveEuVatRegime(input)
  assert.equal(d.kind === 'SCHEME' && d.regime, 'DDP')
  assert.equal(d.kind === 'SCHEME' && d.basis.pluginFx.recorded && d.basis.pluginFx.rate, '1')
  // the same order without the account refuses; in decide mode it decides by value
  const bare = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), wcOrder(), { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP' })
  assert.equal(resolveEuVatRegime(bare).kind === 'REFUSE' && (resolveEuVatRegime(bare) as { code: string }).code, 'plugin_account_missing')
  const decide = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), wcOrder(), { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide' })
  assert.equal(decide.mode, 'decide')
  assert.equal(resolveEuVatRegime(decide).kind === 'SCHEME' && (resolveEuVatRegime(decide) as { regime: string }).regime, 'IOSS')
})

test('gift-card cut-in: unset is off; an order at or after the cut-in needs a flag on every line; before it is lenient; an invalid setting refuses', async () => {
  const cutIn = { state: 'ok' as const, at: new Date('2026-11-01T10:00:00Z') }
  assert.equal(giftCardFlagPolicy({ state: 'unset' }, new Date('2030-01-01T00:00:00Z')), 'off')
  assert.equal(giftCardFlagPolicy(cutIn, new Date('2026-11-01T09:59:59Z')), 'off')
  assert.equal(giftCardFlagPolicy(cutIn, new Date('2026-11-01T10:00:00Z')), 'required')
  assert.equal(giftCardFlagPolicy({ state: 'invalid', raw: 'x' }, new Date('2026-01-01T00:00:00Z')), 'setting_unreadable')
  assert.equal(giftCardFlagPolicy(cutIn, new Date('nope')), 'setting_unreadable')
  const client = fakeClient({ mappings: [mappingRow(216, {})] })
  const unflagged = wcOrder({ line_items: [{ id: 1, total: '100.00', meta_data: [meta('_o3d_is_voucher', 'no')] }, { id: 2, total: '5.00', meta_data: [] }] as never })
  const after = await buildEuVatRegimeInput(client, unflagged, { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide', giftCardCutIn: { state: 'ok', at: new Date('2026-10-01T00:00:00Z') } })
  assert.equal(after.giftCardFlag, 'required')
  assert.equal((resolveEuVatRegime(after) as { code?: string }).code, 'gift_card_flag_missing')
  const before = await buildEuVatRegimeInput(client, unflagged, { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide', giftCardCutIn: { state: 'ok', at: new Date('2026-12-01T00:00:00Z') } })
  assert.equal(before.giftCardFlag, 'off')
  assert.equal(resolveEuVatRegime(before).kind, 'SCHEME')
  const flagged = wcOrder({ line_items: [{ id: 1, total: '100.00', meta_data: [meta('_o3d_is_voucher', 'no')] }, { id: 2, total: '5.00', meta_data: [meta('_o3d_is_voucher', 'yes')] }] as never })
  const ok = await buildEuVatRegimeInput(client, flagged, { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide', giftCardCutIn: { state: 'ok', at: new Date('2026-10-01T00:00:00Z') } })
  assert.equal(resolveEuVatRegime(ok).kind, 'SCHEME')
  const unset = await buildEuVatRegimeInput(client, unflagged, { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide' })
  assert.equal(unset.giftCardFlag, 'off')
})

// ---- unreadable figures are named, never defaulted to 0 -------------------------------------------------------------------------------------------------------------
test('well-formed figures report nothing unreadable', () => {
  assert.deepEqual(readWcEuVatFacts(wcOrder()).unreadable, [])
})

test('a malformed goods line total, tax line amount, rate id or order tax is named as unreadable', () => {
  const unreadable = (over: Partial<WcFullOrder>) => readWcEuVatFacts(wcOrder(over)).unreadable
  assert.match(unreadable({ line_items: [{ id: 9, total: 'abc', meta_data: [] }] as never }).join(), /goods line 1 \(id 9\) has an unreadable total/)
  assert.match(unreadable({ line_items: [{ id: 9, meta_data: [] }] as never }).join(), /goods line 1/)
  assert.match(unreadable({ line_items: [{ id: 1, total: '1e3', meta_data: [] }] as never }).join(), /unreadable total/)
  assert.match(unreadable({ tax_lines: [{ id: 1, rate_id: 216, tax_total: 'x', shipping_tax_total: '2.00' }] as never }).join(), /rate 216 has an unreadable tax total/)
  assert.match(unreadable({ tax_lines: [{ id: 1, rate_id: 216, tax_total: '17.00', shipping_tax_total: undefined }] as never }).join(), /rate 216 has an unreadable shipping tax total/)
  assert.match(unreadable({ tax_lines: [{ id: 1, rate_id: 0, tax_total: '17.00', shipping_tax_total: '0' }] as never }).join(), /tax line 1 has an unreadable rate id/)
  assert.match(unreadable({ tax_lines: [{ id: 1, rate_id: '216', tax_total: '17.00', shipping_tax_total: '0' }] as never }).join(), /unreadable rate id/)
  assert.match(unreadable({ total_tax: 'n/a' }).join(), /order tax total/)
  assert.match(unreadable({ total_tax: undefined as never }).join(), /order tax total/)
  assert.match(unreadable({ currency: '' }).join(), /currency/)
  assert.match(unreadable({ currency: 'EURO' }).join(), /currency/)
  assert.match(unreadable({ fee_lines: [{ id: 1, name: 'Import Duty', total: 'x', total_tax: '0', meta_data: [meta('_wclc_fee', '1'), meta('_wclc_fee_kind', 'duty_fee')] }] as never }).join(), /duty fee line "Import Duty"/)
  // an unreadable total on a fee that is not the duty fee is not this reader's business
  assert.deepEqual(unreadable({ fee_lines: [{ id: 1, name: 'Other', total: 'x', total_tax: '0', meta_data: [] }] as never }), [])
  assert.match(unreadable({ meta_data: [meta('_o3d_ioss_vat_account', { a: 1 })] }).join(), /plugin VAT account/)
  assert.match(unreadable({ meta_data: [meta('_o3d_ioss_reason', 5)] }).join(), /plugin reason/)
  // empty strings and absent metas are not unreadable
  assert.deepEqual(unreadable({ meta_data: [meta('_o3d_ioss_vat_account', ''), meta('_o3d_ioss_reason', '')] }), [])
})

test('every malformed figure refuses the order end to end, before it is resolved', async () => {
  const bad: Array<[string, Partial<WcFullOrder>]> = [
    ['line total', { line_items: [{ id: 1, total: 'abc', meta_data: [] }] as never }],
    ['rate tax', { tax_lines: [{ id: 1, rate_id: 216, tax_total: 'x', shipping_tax_total: '2.00' }] as never }],
    ['order tax', { total_tax: 'n/a' }],
  ]
  for (const [name, over] of bad) {
    const input = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), wcOrder(over), { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode: 'decide' })
    const d = resolveEuVatRegime(input)
    assert.equal(d.kind === 'REFUSE' && d.code, 'order_figure_unreadable', name)
  }
})

test('a plugin FX field that is present but unreadable is an unreadable figure (both modes refuse first); a missing one is only incomplete', async () => {
  const withFx = (entries: Array<[string, unknown]>) => wcOrder({ meta_data: entries.map(([k, v]) => meta(k, v)) })
  const good: Array<[string, unknown]> = [['_o3d_ioss_fx_rate', '1'], ['_o3d_ioss_fx_pair', 'EUR>EUR'], ['_o3d_ioss_threshold_value', '100.00']]
  assert.deepEqual(readWcEuVatFacts(withFx(good)).unreadable, [])
  const cases: Array<[string, Array<[string, unknown]>, RegExp]> = [
    ['rate', [['_o3d_ioss_fx_rate', 'abc'], good[1]!, good[2]!], /FX rate \(_o3d_ioss_fx_rate\) is present but unreadable/],
    ['zero rate', [['_o3d_ioss_fx_rate', '0'], good[1]!, good[2]!], /FX rate/],
    ['pair', [good[0]!, ['_o3d_ioss_fx_pair', 'EURUSD'], good[2]!], /FX pair \(_o3d_ioss_fx_pair\)/],
    ['value', [good[0]!, good[1]!, ['_o3d_ioss_threshold_value', '1,5']], /FX threshold value \(_o3d_ioss_threshold_value\)/],
    ['one bad, one missing', [['_o3d_ioss_fx_rate', 'abc'], good[1]!], /FX rate/],
  ]
  for (const [name, entries, pattern] of cases) assert.match(readWcEuVatFacts(withFx(entries)).unreadable.join(), pattern, name)
  // a missing field alone is incomplete, not unreadable
  const missing = readWcEuVatFacts(withFx([good[0]!, good[1]!]))
  assert.deepEqual(missing.unreadable, [])
  assert.equal(missing.pluginFx.state, 'incomplete')
  // end to end: both modes refuse first with order_figure_unreadable, before any adopt-mode FX check
  for (const mode of ['adopt_plugin', 'decide'] as const) {
    const order = withFx([['_o3d_ioss_vat_account', '821'], ['_o3d_ioss_fx_rate', 'abc'], good[1]!, good[2]!])
    const input = await buildEuVatRegimeInput(fakeClient({ mappings: [mappingRow(216, {})] }), order, { ioss: '821', ddp: '232' }, { baseCurrency: 'GBP', mode })
    const d = resolveEuVatRegime(input)
    assert.equal(d.kind === 'REFUSE' && d.code, 'order_figure_unreadable', mode)
  }
})
