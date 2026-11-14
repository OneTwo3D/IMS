/**
 * THE FACTS THE EU VAT REGIME RESOLVER READS, gathered from a WooCommerce order (lib/domain/accounting/eu-vat-regime.ts decides; this only reads).
 *
 * Two halves.
 *  - `readWcEuVatFacts` is pure: the order's destination, goods lines (with the gift-card flag), tax per rate id, the B2B exemption flag, the EU VAT Compliance record, the EAS cross-check figure,
 *    the plugin's recorded VAT account and its conversion record (`_o3d_ioss_fx_rate`, `_o3d_ioss_fx_pair`, `_o3d_ioss_threshold_value`) and the over-threshold duty fee, all from the order payload.
 *  - `buildEuVatRegimeInput` adds what only the database knows: the IMS rate each WooCommerce rate id is mapped to (loaded by id, never by label), the order-date exchange rate for the
 *    threshold, and the configured VAT accounts.
 *
 * EVERY ORDER META IS ABSENT-ABLE. Which of `vat_compliance_vat_paid`, `is_vat_exempt`, `easproj_payload`, `_o3d_ioss_vat_account` and `_o3d_is_voucher` the REST API exposes has not been
 * established on the live store, so each is read with an explicit UNKNOWN state, never as "no". The resolver decides what unknown means: a missing `is_vat_exempt` on an EU-27 order with no scheme VAT, an unflagged goods line that could decide the regime (decide mode) and a missing
 * `_o3d_ioss_vat_account` on a scheme order (adopt mode) all refuse; the others (the VAT record, EAS) only cross-check.
 * An EU VAT record that is present but EMPTY (no rates; it is sometimes empty at checkout) reads as absent: a present, non-empty record that disagrees with the tax lines refuses, an absent one does not.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { getFxRatesToBase, type FxLookupClient } from '@/lib/currencies/fx-lookup'
import type {
  EasFact, EuVatRegimeInput, EuVatRegimeMode, GoodsLineFact, PluginFxFact, RateFact, RateMappingFact, ThresholdFxFact, VatRecordFact,
} from '@/lib/domain/accounting/eu-vat-regime'
import { normaliseDestination } from '@/lib/domain/accounting/eu-vat-regime'
import { EU_VAT_GIFT_CARD_CUT_IN_SETTING, EU_VAT_REGIME_MODE_SETTING, parseGiftCardCutIn, parseRegimeMode, parseStrictIsoInstant, type GiftCardCutIn } from '@/lib/domain/accounting/eu-vat-settings'
import { getSettingValues } from '@/lib/settings-store'
import { applyGiftCardLineResolutions, loadGiftCardLineResolutions, type GiftCardResolutionClient } from './gift-card-line-resolution'
import { readWclcFeeKind, wcMetaFlag } from './field-mapping'
import { parseWcGmtInstant } from './receipt-settlement-rate'
import type { WcFullOrder, WcMeta } from './types'

/** What the pure half reads; everything the database adds is separate. */
export type WcEuVatFacts = Omit<EuVatRegimeInput, 'rates' | 'thresholdFx' | 'accounts' | 'mode' | 'giftCardFlag'> & {
  /** WooCommerce rate ids that carry a non-zero tax amount, with the tax summed over items, shipping and fees, in the order currency. */
  rateTax: Array<{ wooRateId: number; tax: string }>
}

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value)

function metaValue(meta: readonly WcMeta[] | undefined, key: string): unknown {
  return (meta ?? []).find((entry) => entry.key === key)?.value
}

function decimalText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim()
  return null
}

function currencyText(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null
}

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)
  || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)

/** Parse a meta that WooCommerce may hand over as an object or as JSON text: `empty`, an object, or `unreadable` (text that is not JSON, or JSON that is not an object). */
function readRecord(value: unknown): { kind: 'empty' } | { kind: 'object'; record: Record<string, unknown> } | { kind: 'unreadable'; detail: string } {
  if (isEmpty(value)) return { kind: 'empty' }
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return { kind: 'unreadable', detail: 'not JSON' }
    }
    if (isEmpty(parsed)) return { kind: 'empty' }
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? { kind: 'object', record: parsed as Record<string, unknown> } : { kind: 'unreadable', detail: 'not an object' }
}

/**
 * The EU VAT Compliance record. EMPTY (nothing, or no rates) is `absent`, which never refuses. A record with rates whose total or currency cannot be read, or text that is not a record, is `unreadable`, which refuses a scheme order.
 */
export function readVatRecord(order: Pick<WcFullOrder, 'meta_data'>): VatRecordFact {
  const read = readRecord(metaValue(order.meta_data, 'vat_compliance_vat_paid'))
  if (read.kind === 'empty') return { state: 'absent' }
  if (read.kind === 'unreadable') return { state: 'unreadable', detail: read.detail }
  const record = read.record
  const byRates = record.by_rates
  if (isEmpty(byRates)) return { state: 'absent' }
  if (typeof byRates !== 'object') return { state: 'unreadable', detail: 'by_rates is not a list' }
  const total = decimalText(record.total)
  if (total === null) return { state: 'unreadable', detail: 'total is missing or not a number' }
  const currency = isEmpty(record.currency) ? null : currencyText(record.currency)
  if (!isEmpty(record.currency) && currency === null) return { state: 'unreadable', detail: 'currency is not a three-letter code' }
  return { state: 'present', currency, total }
}

/** The EAS payload: only a cross-check. Empty or without a merchandise value is `absent`; a merchandise value or currency that cannot be read is `unreadable` (a warning, not a refusal). */
export function readEasFact(order: Pick<WcFullOrder, 'meta_data'>): EasFact {
  const read = readRecord(metaValue(order.meta_data, 'easproj_payload'))
  if (read.kind === 'empty') return { state: 'absent' }
  if (read.kind === 'unreadable') return { state: 'unreadable', detail: read.detail }
  const raw = read.record.merchandise_cost_vat_excl
  if (isEmpty(raw)) return { state: 'absent' }
  const merchandise = decimalText(raw)
  if (merchandise === null) return { state: 'unreadable', detail: 'merchandise_cost_vat_excl is not a number' }
  const currency = isEmpty(read.record.payment_currency) ? null : currencyText(read.record.payment_currency)
  if (!isEmpty(read.record.payment_currency) && currency === null) return { state: 'unreadable', detail: 'payment_currency is not a three-letter code' }
  return { state: 'present', merchandiseVatExcl: merchandise, currency }
}

/** The marker the plugin appends to `_o3d_ioss_reason` when FX meta already existed and differed from its decision, so it kept the old values. */
export const PLUGIN_FX_CONFLICT_MARKER = 'FX meta already present and different from this decision'

export function readPluginFxConflict(order: Pick<WcFullOrder, 'meta_data'>): boolean {
  const reason = metaValue(order.meta_data, '_o3d_ioss_reason')
  return typeof reason === 'string' && reason.includes(PLUGIN_FX_CONFLICT_MARKER)
}

/**
 * The plugin's own conversion record: `_o3d_ioss_fx_rate` (exact decimal string), `_o3d_ioss_fx_pair` ("GBP>EUR") and `_o3d_ioss_threshold_value` (two decimals), written together with the account.
 * None of the three is `absent` (an order from before the plugin wrote them); all three readable is `present`; anything between is `incomplete`. A field that is present but unreadable is also named in `problems`.
 */
export function readPluginFx(order: Pick<WcFullOrder, 'meta_data'>, problems: string[] = []): PluginFxFact {
  const keys = ['_o3d_ioss_fx_rate', '_o3d_ioss_fx_pair', '_o3d_ioss_threshold_value']
  const raw = keys.map((key) => metaValue(order.meta_data, key))
  const given = raw.map((value) => value !== undefined && !(typeof value === 'string' && value.trim() === ''))
  if (given.every((g) => !g)) return { state: 'absent' }
  const rate = decimalText(raw[0])
  const pairRaw = raw[1]
  const pair = typeof pairRaw === 'string' && /^[A-Za-z]{3}>[A-Za-z]{3}$/.test(pairRaw.trim()) ? pairRaw.trim().toUpperCase() : null
  const thresholdValue = decimalText(raw[2])
  const readable = [rate !== null && D(rate).gt(0), pair !== null, thresholdValue !== null]
  const names = ['rate', 'pair', 'threshold value']
  // A field that is present but cannot be read is an unreadable figure of the order (both modes refuse first); a field that is simply missing makes the record incomplete (adopt mode refuses).
  readable.forEach((ok, i) => { if (!ok && given[i]) problems.push(`the plugin FX ${names[i]} (${keys[i]}) is present but unreadable`) })
  const bad = names.filter((_, i) => !readable[i])
  if (bad.length > 0) return { state: 'incomplete', detail: `${bad.join(', ')} ${given.every(Boolean) ? 'unreadable' : 'missing or unreadable'}` }
  return { state: 'present', rate: rate!, pair: pair!, thresholdValue: thresholdValue! }
}

/** A flag value the plugin writes for "no": 'no', '0', 'false', '' (or the boolean/number forms). Anything else that is not a yes is unreadable. */
function readFalsyFlag(value: unknown): boolean {
  if (value === false || value === 0) return true
  return typeof value === 'string' && ['no', '0', 'false', ''].includes(value.trim().toLowerCase())
}

/** The gift-card flag read STRICTLY: exactly the text `yes` or `no`, nothing else (not empty, not whitespace, not 0/false/1, not a boolean). Used for the cut-in; the lenient reading above is kept for orders before it. */
function readStrictFlag(value: unknown): 'yes' | 'no' | 'unknown' {
  return value === 'yes' ? 'yes' : value === 'no' ? 'no' : 'unknown'
}

export function readGoodsLines(order: Pick<WcFullOrder, 'line_items'>, problems: string[] = []): GoodsLineFact[] {
  return order.line_items.map((line, index) => {
    // EVERY entry for the key is read: WooCommerce meta may hold the key more than once. Entries that read differently (yes and no, or a readable one beside an unreadable one) make the flag unknown, never first-wins.
    const entries = (line.meta_data ?? []).filter((entry) => entry.key === '_o3d_is_voucher')
    const lenient = (value: unknown): 'yes' | 'no' | 'unknown' => (wcMetaFlag(value) ? 'yes' : readFalsyFlag(value) ? 'no' : 'unknown')
    const agree = (readings: Array<'yes' | 'no' | 'unknown'>): 'yes' | 'no' | 'unknown' => (readings.length > 0 && readings.every((r) => r === readings[0]) ? readings[0]! : 'unknown')
    const total = decimalText(line.total)
    if (total === null) problems.push(`goods line ${index + 1} (id ${String(line.id)}) has an unreadable total`)
    // Only the line's own flag is read. The product-level marker (`_coupon_title`) is not on the order and IMS imports no product meta, so a line with no (or an unreadable) flag is unknown and the resolver decides what that means.
    return { total: total ?? '0', ...(Number.isInteger(line.id) ? { lineId: line.id } : {}), voucherStrict: agree(entries.map((e) => readStrictFlag(e.value))), voucher: agree(entries.map((e) => lenient(e.value))) }
  })
}

/** Tax per WooCommerce rate id from the order's tax lines: the items-and-fees tax plus the shipping tax. An unreadable amount or rate id is named in `problems`, never counted as 0. */
export function readRateTax(order: Pick<WcFullOrder, 'tax_lines'>, problems: string[] = []): Array<{ wooRateId: number; tax: string }> {
  const byId = new Map<number, Prisma.Decimal>()
  for (const [index, line] of (order.tax_lines ?? []).entries()) {
    const items = decimalText(line.tax_total)
    const shipping = decimalText(line.shipping_tax_total)
    if (!Number.isInteger(line.rate_id) || line.rate_id <= 0) {
      problems.push(`tax line ${index + 1} has an unreadable rate id`)
      continue
    }
    if (items === null) problems.push(`tax line for rate ${line.rate_id} has an unreadable tax total`)
    if (shipping === null) problems.push(`tax line for rate ${line.rate_id} has an unreadable shipping tax total`)
    byId.set(line.rate_id, (byId.get(line.rate_id) ?? D(0)).plus(D(items ?? '0')).plus(D(shipping ?? '0')))
  }
  return [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([wooRateId, tax]) => ({ wooRateId, tax: tax.toString() }))
}

export function readWcEuVatFacts(order: WcFullOrder): WcEuVatFacts {
  const unreadable: string[] = []
  const account = metaValue(order.meta_data, '_o3d_ioss_vat_account')
  let pluginVatAccount: string | null = null
  if (typeof account === 'string' || typeof account === 'number') pluginVatAccount = String(account).trim() === '' ? null : String(account).trim()
  else if (account !== undefined && account !== null) unreadable.push('the plugin VAT account (_o3d_ioss_vat_account) is not text')
  const reason = metaValue(order.meta_data, '_o3d_ioss_reason')
  if (reason !== undefined && reason !== null && typeof reason !== 'string') unreadable.push('the plugin reason (_o3d_ioss_reason) is not text')
  const exempt = metaValue(order.meta_data, 'is_vat_exempt')
  const currency = (order.currency ?? '').toString().trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) unreadable.push('the order currency is missing or not a three-letter code')
  const orderTax = decimalText(order.total_tax)
  if (orderTax === null) unreadable.push('the order tax total (total_tax) is unreadable')
  const goodsLines = readGoodsLines(order, unreadable)
  const rateTax = readRateTax(order, unreadable)
  let overThresholdDutyFee = false
  for (const fee of order.fee_lines ?? []) {
    if (readWclcFeeKind(fee) !== 'duty_fee') continue
    const total = decimalText(fee.total)
    if (total === null) unreadable.push(`the over-threshold duty fee line "${String(fee.name)}" has an unreadable total`)
    else if (D(total).abs().gt(0)) overThresholdDutyFee = true
  }
  return {
    unreadable,
    shippingCountry: order.shipping?.country?.trim() ? order.shipping.country : null,
    billingCountry: order.billing?.country?.trim() ? order.billing.country : null,
    currency,
    goodsLines,
    rateTax,
    orderTax: orderTax ?? '0',
    vatExempt: exempt === undefined ? 'unknown' : wcMetaFlag(exempt) ? 'yes' : readFalsyFlag(exempt) ? 'no' : 'unknown',
    pluginFxConflict: readPluginFxConflict(order),
    vatRecord: readVatRecord(order),
    eas: readEasFact(order),
    pluginFx: readPluginFx(order, unreadable),
    pluginVatAccount,
    overThresholdDutyFee,
  }
}

type MappingClient = { shoppingTaxRateMapping: Pick<Prisma.TransactionClient['shoppingTaxRateMapping'], 'findMany'> }

/** The IMS rate each WooCommerce rate id is mapped to. An id with no mapping row is `unmapped`. */
export async function loadRateMappings(client: MappingClient, wooRateIds: readonly number[]): Promise<Map<number, RateMappingFact>> {
  const out = new Map<number, RateMappingFact>()
  for (const id of wooRateIds) out.set(id, { state: 'unmapped' })
  if (wooRateIds.length === 0) return out
  const rows = await client.shoppingTaxRateMapping.findMany({
    where: { connector: 'woocommerce', externalTaxRateId: { in: wooRateIds.map(String) } },
    select: { externalTaxRateId: true, taxRate: { select: { id: true, name: true, rate: true, active: true, countryCode: true, reportingCategory: true, schemePostingTaxType: true } } },
  })
  for (const row of rows) {
    const id = Number(row.externalTaxRateId)
    if (!out.has(id)) continue
    out.set(id, {
      state: 'mapped',
      imsRateId: row.taxRate.id,
      name: row.taxRate.name,
      active: row.taxRate.active,
      countryCode: row.taxRate.countryCode === null ? null : normaliseDestination(row.taxRate.countryCode),
      rate: row.taxRate.rate.toString(),
      reportingCategory: row.taxRate.reportingCategory,
      schemePostingTaxType: row.taxRate.schemePostingTaxType,
    })
  }
  return out
}

/**
 * Order currency to the threshold currency (EUR, NOK for Norway) at the ORDER DATE, from IMS's own rates (owner ruling 2026-10-24: one FX master; ruling Q5: this can differ from the plugin's live
 * rate on a boundary order). Same currency needs no rate. A missing rate is `unavailable`, which the resolver refuses on; nothing is defaulted.
 */
export async function resolveThresholdFx(
  client: FxLookupClient,
  params: { currency: string; destination: string; orderedAt: Date; baseCurrency?: string },
): Promise<ThresholdFxFact> {
  const target = params.destination === 'NO' ? 'NOK' : 'EUR'
  const asOf = params.orderedAt.toISOString()
  if (params.currency === target) return { state: 'ok', rate: '1', sameCurrency: true, asOf, source: 'same currency' }
  try {
    const rates = await getFxRatesToBase(client, { currencies: [params.currency, target], asOf: params.orderedAt, baseCurrency: params.baseCurrency })
    const from = rates.get(params.currency)
    const to = rates.get(target)
    if (!from || !to) return { state: 'unavailable', reason: `no exchange rate for ${!from ? params.currency : target}` }
    // 1 base = from.rate order-currency units = to.rate target units, so one order-currency unit is to.rate / from.rate target units.
    return { state: 'ok', rate: to.rate.div(from.rate).toString(), sameCurrency: false, asOf, source: `fx_rates ${params.currency}/${target} at order date (${from.source}, ${to.source})` }
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : 'exchange rate lookup failed' }
  }
}

/** The mode in force, read from the setting. A stored value that is neither mode reads as null: the caller refuses rather than guesses. */
export async function readEuVatRegimeMode(): Promise<EuVatRegimeMode | null> {
  const values = await getSettingValues([EU_VAT_REGIME_MODE_SETTING])
  return parseRegimeMode(values.get(EU_VAT_REGIME_MODE_SETTING))
}

/** The gift-card flag cut-in as stored: unset, a date, or invalid (never coerced). */
export async function readGiftCardFlagCutIn(): Promise<GiftCardCutIn> {
  const values = await getSettingValues([EU_VAT_GIFT_CARD_CUT_IN_SETTING])
  return parseGiftCardCutIn(values.get(EU_VAT_GIFT_CARD_CUT_IN_SETTING))
}

/**
 * The instant the cut-in is compared with: `date_created_gmt` ONLY. `date_created` is in the store's local time and IMS does not store the store timezone, so it is never converted or guessed: with no
 * readable GMT date the result is an invalid Date, which `giftCardFlagPolicy` turns into `setting_unreadable` (a refusal) when a cut-in is set.
 */
export function giftCardOrderedAt(order: Pick<WcFullOrder, 'date_created_gmt'>): Date {
  const gmt = (order.date_created_gmt ?? '').toString().trim()
  return parseStrictIsoInstant(gmt, { dateOnly: false, assumeUtc: true }) ?? new Date(Number.NaN)
}

/** Whether the order must carry the gift-card flag on every line: it was created at or after the cut-in. An unset cut-in is `off`; an invalid one, or a set one with no readable order date, is `setting_unreadable`. */
export function giftCardFlagPolicy(cutIn: GiftCardCutIn, orderedAt: Date): 'off' | 'required' | 'setting_unreadable' {
  if (cutIn.state === 'unset') return 'off'
  if (cutIn.state === 'invalid' || Number.isNaN(orderedAt.getTime())) return 'setting_unreadable'
  return orderedAt.getTime() >= cutIn.at.getTime() ? 'required' : 'off'
}

/** The answer table is optional on the client: a client without it has no answers, so unsettled lines keep refusing. */
export type EuVatRegimeInputClient = MappingClient & FxLookupClient & Partial<GiftCardResolutionClient>

/** The resolver's whole input for a WooCommerce order. `accounts` are the configured VAT account codes (Xero account roles). */
export async function buildEuVatRegimeInput(
  client: EuVatRegimeInputClient,
  order: WcFullOrder,
  accounts: { ioss: string | null; ddp: string | null },
  options: { baseCurrency?: string; mode?: EuVatRegimeMode; giftCardCutIn: GiftCardCutIn },
): Promise<EuVatRegimeInput> {
  const facts = readWcEuVatFacts(order)
  const mappings = await loadRateMappings(client, facts.rateTax.map((r) => r.wooRateId))
  const rates: RateFact[] = facts.rateTax.map((r) => ({ wooRateId: r.wooRateId, tax: r.tax, mapping: mappings.get(r.wooRateId) ?? { state: 'unmapped' } }))
  const destination = normaliseDestination(facts.shippingCountry) || normaliseDestination(facts.billingCountry)
  const orderedAt = parseWcGmtInstant(order.date_created_gmt || order.date_created)
  const thresholdFx: ThresholdFxFact = Number.isNaN(orderedAt.getTime())
    ? { state: 'unavailable', reason: 'the order has no readable creation date' }
    : await resolveThresholdFx(client, { currency: facts.currency, destination, orderedAt, baseCurrency: options.baseCurrency })
  const { rateTax: _rateTax, ...rest } = facts
  void _rateTax
  // An operator's answer fills a line the plugin left unsettled (never a readable yes/no); asked only when there is such a line.
  const needsAnswer = rest.goodsLines.some((line) => line.lineId !== undefined && (line.voucherStrict ?? 'unknown') === 'unknown')
  const goodsLines = needsAnswer ? applyGiftCardLineResolutions(rest.goodsLines, await loadGiftCardLineResolutions(client, String(order.id))) : rest.goodsLines
  return { ...rest, goodsLines, mode: options.mode ?? 'adopt_plugin', rates, thresholdFx, accounts, giftCardFlag: giftCardFlagPolicy(options.giftCardCutIn, giftCardOrderedAt(order)) }
}

/**
 * The production entry: reads the gift-card cut-in setting itself and passes its parsed state to `buildEuVatRegimeInput` explicitly. A setting that cannot be read (the read throws) is an invalid cut-in, which refuses the order
 * (`gift_card_cut_in_unreadable`); it is never treated as unset.
 */
export async function buildEuVatRegimeInputFromSettings(
  client: EuVatRegimeInputClient,
  order: WcFullOrder,
  accounts: { ioss: string | null; ddp: string | null },
  options: { baseCurrency?: string; mode?: EuVatRegimeMode } = {},
  readCutIn: () => Promise<GiftCardCutIn> = readGiftCardFlagCutIn,
): Promise<EuVatRegimeInput> {
  let giftCardCutIn: GiftCardCutIn
  try {
    giftCardCutIn = await readCutIn()
  } catch {
    giftCardCutIn = { state: 'invalid', raw: 'setting could not be read' }
  }
  return buildEuVatRegimeInput(client, order, accounts, { ...options, giftCardCutIn })
}
