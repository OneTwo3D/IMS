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
 * established on the live store, so a missing or unreadable one reads as absent. Only `is_vat_exempt` (B2B) and `_o3d_ioss_vat_account` (credit notes) change an outcome when absent, and neither refuses.
 * An EU VAT record that is present but EMPTY (no rates; it is sometimes empty at checkout) reads as absent: a present, non-empty record that disagrees with the tax lines refuses, an absent one does not.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { getFxRatesToBase, type FxLookupClient } from '@/lib/currencies/fx-lookup'
import type {
  EasFact, EuVatRegimeInput, EuVatRegimeMode, GoodsLineFact, PluginFxFact, RateFact, RateMappingFact, ThresholdFxFact, VatRecordFact,
} from '@/lib/domain/accounting/eu-vat-regime'
import { normaliseDestination } from '@/lib/domain/accounting/eu-vat-regime'
import { EU_VAT_REGIME_MODE_SETTING, parseRegimeMode } from '@/lib/domain/accounting/eu-vat-settings'
import { getSettingValues } from '@/lib/settings-store'
import { readWclcFeeKind, wcMetaFlag } from './field-mapping'
import { parseWcGmtInstant } from './receipt-settlement-rate'
import type { WcFullOrder, WcMeta } from './types'

/** What the pure half reads; everything the database adds is separate. */
export type WcEuVatFacts = Omit<EuVatRegimeInput, 'rates' | 'thresholdFx' | 'accounts' | 'mode'> & {
  /** WooCommerce rate ids that carry a non-zero tax amount, with the tax summed over items, shipping and fees, in the order currency. */
  rateTax: Array<{ wooRateId: number; tax: string }>
}

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value)

function metaValue(meta: readonly WcMeta[] | undefined, key: string): unknown {
  return (meta ?? []).find((entry) => entry.key === key)?.value
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function decimalText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim()
  return null
}

function currencyText(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null
}

/** The EU VAT Compliance record: present only when readable, with at least one rate, and with a total. */
export function readVatRecord(order: Pick<WcFullOrder, 'meta_data'>): VatRecordFact {
  const record = asObject(metaValue(order.meta_data, 'vat_compliance_vat_paid'))
  if (record === null) return { state: 'absent' }
  const byRates = record.by_rates
  const rateCount = Array.isArray(byRates) ? byRates.length : byRates !== null && typeof byRates === 'object' ? Object.keys(byRates).length : 0
  const total = decimalText(record.total)
  if (rateCount === 0 || total === null) return { state: 'absent' }
  return { state: 'present', currency: currencyText(record.currency), total }
}

export function readEasFact(order: Pick<WcFullOrder, 'meta_data'>): EasFact {
  const payload = asObject(metaValue(order.meta_data, 'easproj_payload'))
  const merchandise = payload === null ? null : decimalText(payload.merchandise_cost_vat_excl)
  if (payload === null || merchandise === null) return { state: 'absent' }
  return { state: 'present', merchandiseVatExcl: merchandise, currency: currencyText(payload.payment_currency) }
}

/** The plugin's own conversion record. Present only when the rate and the pair are both readable; the threshold value is carried when readable. */
export function readPluginFx(order: Pick<WcFullOrder, 'meta_data'>): PluginFxFact {
  const rate = decimalText(metaValue(order.meta_data, '_o3d_ioss_fx_rate'))
  const pairRaw = metaValue(order.meta_data, '_o3d_ioss_fx_pair')
  const pair = typeof pairRaw === 'string' && /^[A-Za-z]{3}>[A-Za-z]{3}$/.test(pairRaw.trim()) ? pairRaw.trim().toUpperCase() : null
  if (rate === null || pair === null || !D(rate).gt(0)) return { state: 'absent' }
  return { state: 'present', rate, pair, thresholdValue: decimalText(metaValue(order.meta_data, '_o3d_ioss_threshold_value')) }
}

export function readGoodsLines(order: Pick<WcFullOrder, 'line_items'>): GoodsLineFact[] {
  return order.line_items.map((line) => {
    const flag = (line.meta_data ?? []).find((entry) => entry.key === '_o3d_is_voucher')
    const total = decimalText(line.total) ?? '0'
    // Only the line's own flag is read. The product-level marker (`_coupon_title`) is not on the order and IMS imports no product meta, so an unflagged gift card is goods here.
    return { total, voucher: flag !== undefined && wcMetaFlag(flag.value) }
  })
}

/** Tax per WooCommerce rate id from the order's tax lines: the items-and-fees tax plus the shipping tax. */
export function readRateTax(order: Pick<WcFullOrder, 'tax_lines'>): Array<{ wooRateId: number; tax: string }> {
  const byId = new Map<number, Prisma.Decimal>()
  for (const line of order.tax_lines ?? []) {
    const amount = D(decimalText(line.tax_total) ?? '0').plus(D(decimalText(line.shipping_tax_total) ?? '0'))
    byId.set(line.rate_id, (byId.get(line.rate_id) ?? D(0)).plus(amount))
  }
  return [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([wooRateId, tax]) => ({ wooRateId, tax: tax.toString() }))
}

export function readWcEuVatFacts(order: WcFullOrder): WcEuVatFacts {
  const account = metaValue(order.meta_data, '_o3d_ioss_vat_account')
  const accountText = typeof account === 'string' || typeof account === 'number' ? String(account).trim() : ''
  const exempt = metaValue(order.meta_data, 'is_vat_exempt')
  return {
    shippingCountry: order.shipping?.country?.trim() ? order.shipping.country : null,
    billingCountry: order.billing?.country?.trim() ? order.billing.country : null,
    currency: (order.currency ?? '').trim().toUpperCase(),
    goodsLines: readGoodsLines(order),
    rateTax: readRateTax(order),
    orderTax: decimalText(order.total_tax) ?? '0',
    vatExempt: exempt !== undefined && wcMetaFlag(exempt),
    vatRecord: readVatRecord(order),
    eas: readEasFact(order),
    pluginFx: readPluginFx(order),
    pluginVatAccount: accountText === '' ? null : accountText,
    overThresholdDutyFee: (order.fee_lines ?? []).some((fee) => readWclcFeeKind(fee) === 'duty_fee' && D(decimalText(fee.total) ?? '0').abs().gt(0)),
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

export type EuVatRegimeInputClient = MappingClient & FxLookupClient

/** The resolver's whole input for a WooCommerce order. `accounts` are the configured VAT account codes (Xero account roles). */
export async function buildEuVatRegimeInput(
  client: EuVatRegimeInputClient,
  order: WcFullOrder,
  accounts: { ioss: string | null; ddp: string | null },
  options: { baseCurrency?: string; mode?: EuVatRegimeMode } = {},
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
  return { ...rest, mode: options.mode ?? 'adopt_plugin', rates, thresholdFx, accounts }
}
