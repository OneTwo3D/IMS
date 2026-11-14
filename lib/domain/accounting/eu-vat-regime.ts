/**
 * THE EU VAT REGIME OF AN ORDER (IOSS, VOEC or DDP), decided from facts. Pure: no database, no clock, no WooCommerce types.
 *
 * It mirrors the storefront plugin's resolver (o3d-ioss-xero `O3D_IOSS_Resolver::decide`) so that IMS reaches the same answer for the same order, with the owner rulings of 2026-11-09 applied:
 *   - Q1  no goods ship from EU stock, so a rate of an EU country (or Monaco or Norway) that moved money and is NOT on the scheme is a REFUSAL, never "OSS";
 *   - Q2  the IMS rates follow the Xero rates: a scheme rate is an IMS rate carrying `reportingCategory` IOSS or VOEC AND a `schemePostingTaxType` (both, or it is misconfigured and refuses);
 *   - Q5  the threshold test uses the order-date exchange rate IMS holds; a boundary order may therefore differ from the plugin's live rate, which is why a value within 5% of the threshold carries a warning;
 *   - Q6  when accounting (by value) and the customs label (by the presence of the over-threshold duty fee) disagree, the order is NOT refused: accounting follows value and the disagreement is a warning.
 *
 * TWO MODES (`input.mode`, the setting `eu_vat_regime_mode`, default `adopt_plugin`).
 *   adopt_plugin  the parallel phase, while the storefront plugin still posts: the plugin's decision is ADOPTED, not re-made. `_o3d_ioss_vat_account` determines the regime (the IOSS/VOEC account is IOSS, or VOEC for
 *                 Norway; the DDP account is DDP). When an order has scheme VAT and the meta is absent, the order REFUSES: IMS does not guess. The plugin's exchange rate, pair and converted value (`_o3d_ioss_fx_rate`,
 *                 `_o3d_ioss_fx_pair`, `_o3d_ioss_threshold_value`) are recorded in the basis. The value test still runs as a CROSS-CHECK and a disagreement is a warning, never a refusal; the 5% band is not raised here.
 *   decide        after the switchover: IMS decides by value with its own order-date rates (below).
 * The classification of the rates (what is scheme VAT, what refuses) is the same in both modes.
 *
 * ONE OUTPUT, THREE KINDS.
 *   SKIP    the order is not on the scheme path (no scheme VAT, nothing EU-rated). `vatExemptB2b` says whether it is an EU business sale that WooCommerce charged no VAT on (zero-rated goods in a later change).
 *   REFUSE  the order cannot be classified or contradicts itself. Nothing may be posted for it until a person looks. A refusal is never stamped.
 *   SCHEME  the regime, the account the single VAT line posts to, the VAT amount and the zero-rated posting type, with everything the decision rested on.
 *
 * THRESHOLDS ARE CONSTANTS, not settings (a setting is how the customs label code came to disagree with the law). DDP when the converted goods value is STRICTLY above the threshold
 * (EUR 150, or NOK 3000 for Norway); exactly at the threshold is IOSS/VOEC. The value is compared at the minor unit (rounded half up to 2 places): 150.004 is 150.00.
 *
 * UNKNOWN INPUTS DEFER, THEY ARE NOT GUESSED. A goods line with no gift-card flag counts as goods, and in `decide` mode the order REFUSES (`voucher_status_unknown`) when taking those lines out would change the regime. A missing or
 * unreadable VAT-exempt flag on an EU-27 order with no scheme VAT refuses (`vat_exempt_status_unknown`) rather than stamping "outside the scheme". Tax that moved on any rate other than the scheme rates, or a WooCommerce
 * order tax that is not the scheme total, refuses (`tax_not_explained_by_scheme_rates`).
 *
 * PLUGIN CONVERSION RECORD (adopt mode). With the account present: a conversion record that is incomplete or unreadable, or a reason text saying the plugin left differing FX meta unchanged, REFUSES; no conversion record at all
 * (an order from before the plugin wrote it) is stamped from the account and recorded as "not recorded by the plugin" (a deliberate exception so historic orders still work).
 *
 * GIFT-CARD FLAG CUT-IN. When the setting `eu_vat_gift_card_flag_cut_in` is set and the order was created at or after it, a goods line whose flag is missing or unreadable refuses the order (`gift_card_flag_missing`) in both modes
 * and whatever the destination; an unreadable setting refuses everything (`gift_card_cut_in_unreadable`). Unset keeps the reading above.
 *
 * INTRINSIC VALUE = the sum of the goods lines' totals (after coupons, excluding VAT, shipping and fees), gift cards excluded. A gift card is a line flagged `_o3d_is_voucher`; the product-level marker
 * (`_coupon_title`) is not on the order and IMS does not import product meta, so an unflagged gift card counts as goods. That limit only matters in `decide` mode.
 *
 * IDENTIFICATION IS BY RATE ID THROUGH THE MAPPING, never by label (labels are translated). An id with money and no mapping, or mapped to an inactive IMS rate, refuses.
 */
import { Prisma } from '@/app/generated/prisma/client'

type Decimal = Prisma.Decimal
const D = (value: string | number): Decimal => new Prisma.Decimal(value)

export const IOSS_THRESHOLD_EUR = '150'
export const VOEC_THRESHOLD_NOK = '3000'
/** A converted value within this fraction of the threshold is "too close to call": the exchange rate on the day decides the regime. */
export const THRESHOLD_WARN_BAND = '0.05'
/** The plugin's recorded goods value may differ from rate x IMS's goods by this much in the threshold currency (a cent of rounding on each side). */
export const PLUGIN_VALUE_TOLERANCE = '0.02'
/** Tolerance for agreement between two figures that should be equal (the plugin's own). */
export const FIGURE_TOLERANCE = '0.02'
/** Tax below this moved no money. */
export const MONEY_MOVED_MIN = '0.005'

/** The destinations the scheme can cover: EU-27, Monaco (French VAT area) and Norway (VOEC). ISO 3166 alpha-2. */
export const SCHEME_DESTINATIONS: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'MC', 'NO',
])
/** EU member states only: where a VAT-exempt business buyer is zero-rated (Monaco and Norway are not). */
export const EU27: ReadonlySet<string> = new Set([...SCHEME_DESTINATIONS].filter((code) => code !== 'MC' && code !== 'NO'))
/** The territories a UK or Isle of Man rate is ordinary on. A positive amount of either anywhere else is a contradiction. */
export const DOMESTIC_TERRITORIES: Readonly<Record<string, readonly string[]>> = {
  GB: ['GB', 'IM', 'JE', 'GG'],
  IM: ['IM', 'GB'],
}

export type EuVatRegimeName = 'IOSS' | 'VOEC' | 'DDP'

export type RateMappingFact =
  | { state: 'unmapped' }
  | {
      state: 'mapped'
      imsRateId: string
      name: string
      active: boolean
      /** The IMS rate's own country (normalised by the caller: UK is GB, EL is GR), or null. */
      countryCode: string | null
      /** The charged percentage as a fraction string ("0.1900"). */
      rate: string
      reportingCategory: string | null
      schemePostingTaxType: string | null
    }

export type RateFact = {
  /** The WooCommerce tax rate id. */
  wooRateId: number
  /** Tax charged on this rate across items, shipping and fees, in the order currency (a decimal string). */
  tax: string
  mapping: RateMappingFact
}

export type GoodsLineFact = {
  /** The store's own id of the order line (WooCommerce line item id): what an operator's gift-card answer is keyed by. Absent on a line with no readable id. */
  lineId?: number
  /** The line total after coupons, excluding tax, in the order currency. */
  total: string
  /** The gift-card flag (`_o3d_is_voucher`): yes and no were read from the line; unknown means the line carried none and the product-level marker (`_coupon_title`) is not imported to settle it. */
  voucher: 'yes' | 'no' | 'unknown'
  /** The same flag read STRICTLY: only exactly `yes` or `no` count (an empty, blank or other value, and a missing key, are `unknown`). The cut-in rule reads this one; absent here is treated as `unknown` (fail closed). */
  voucherStrict?: 'yes' | 'no' | 'unknown'
}

export type EuVatRegimeMode = 'adopt_plugin' | 'decide'
export const EU_VAT_REGIME_MODES: readonly EuVatRegimeMode[] = ['adopt_plugin', 'decide']

/** What the plugin recorded about its own conversion: `_o3d_ioss_fx_rate` (threshold-currency units per one order-currency unit), `_o3d_ioss_fx_pair` ("GBP>EUR") and `_o3d_ioss_threshold_value`. */
export type PluginFxFact =
  /** None of the three metas exists: an order from before the plugin recorded its conversion. */
  | { state: 'absent' }
  | { state: 'present'; rate: string; pair: string; thresholdValue: string }
  /** Some of the three exist, or one is unreadable. */
  | { state: 'incomplete'; detail: string }

/** `absent`: no record, or an empty one (no rates; it is sometimes empty at checkout). `unreadable`: a non-empty record whose total, currency or shape cannot be read: a scheme order refuses on it. */
export type VatRecordFact = { state: 'absent' } | { state: 'present'; currency: string | null; total: string } | { state: 'unreadable'; detail: string }
export type EasFact = { state: 'absent' } | { state: 'present'; merchandiseVatExcl: string; currency: string | null } | { state: 'unreadable'; detail: string }

/** Order currency to the threshold currency (EUR, or NOK for Norway): units of threshold currency per ONE unit of order currency. */
export type ThresholdFxFact =
  | { state: 'ok'; rate: string; sameCurrency: boolean; asOf: string; source: string }
  | { state: 'unavailable'; reason: string }

export type EuVatRegimeInput = {
  /**
   * Order figures that were present but could not be read (a goods total, a line or order tax, a rate id, a currency, a fee total, the plugin's account or reason). Each is named here instead of becoming 0 or a default;
   * a non-empty list refuses the order before anything else is looked at (`order_figure_unreadable`).
   */
  unreadable: readonly string[]
  mode: EuVatRegimeMode
  pluginFx: PluginFxFact
  shippingCountry: string | null
  billingCountry: string | null
  currency: string
  goodsLines: readonly GoodsLineFact[]
  rates: readonly RateFact[]
  /** WooCommerce's own order tax total, independent of the per-rate lines: tells "no VAT charged" from "the evidence is missing". */
  orderTax: string
  /** The B2B exemption flag (`is_vat_exempt`). */
  vatExempt: 'yes' | 'no' | 'unknown'
  /** The plugin's reason text says it left differing FX meta unchanged (`[FX meta already present and different from this decision; left unchanged: ...]`). */
  pluginFxConflict: boolean
  vatRecord: VatRecordFact
  eas: EasFact
  thresholdFx: ThresholdFxFact
  /** The accounts the single VAT line posts to, from the Xero account roles; blank is not configured. */
  accounts: { ioss: string | null; ddp: string | null }
  /** The account the storefront plugin recorded on the order (`_o3d_ioss_vat_account`), when it handled the order. Only cross-checked here. */
  pluginVatAccount: string | null
  /**
   * REQUIRED, so every builder must decide it. The gift-card flag cut-in (`eu_vat_gift_card_flag_cut_in`), already compared with the order's creation date by the caller. `off` (the default, and absent): today's lenient reading. `required`: the order was created
   * at or after the cut-in, so EVERY line must carry the flag. `setting_unreadable`: the cut-in is set to something that is not a date (or the order date cannot be read), so nothing can be decided.
   */
  giftCardFlag: 'off' | 'required' | 'setting_unreadable'
  /** The customs label's evidence: a non-zero over-threshold duty fee line (`_wclc_fee_kind` duty_fee) is on the order. */
  overThresholdDutyFee: boolean
}

export const REFUSAL_CODES = [
  'rate_unmapped',
  'rate_inactive',
  'scheme_misconfigured',
  'domestic_rate_abroad',
  'eu_rated_not_on_scheme',
  'scheme_rate_outside_destination',
  'tax_without_scheme_rate',
  'multiple_scheme_types',
  'rate_country_mismatch',
  'rate_scheme_mismatch',
  'exempt_but_vat_charged',
  'vat_record_currency_mismatch',
  'vat_record_mismatch',
  'threshold_value_unavailable',
  'vat_account_not_configured',
  'plugin_account_missing',
  'plugin_account_unrecognised',
  'plugin_fx_incomplete',
  'plugin_fx_conflict',
  'plugin_evidence_contradicts',
  'order_figure_unreadable',
  'vat_record_unreadable',
  'tax_not_explained_by_scheme_rates',
  'voucher_status_unknown',
  'gift_card_flag_missing',
  'gift_card_cut_in_unreadable',
  'vat_exempt_status_unknown',
] as const
export type RefusalCode = (typeof REFUSAL_CODES)[number]

export const WARNING_CODES = ['threshold_band', 'eas_disagrees', 'plugin_account_differs', 'label_regime_disagrees', 'adopted_regime_differs', 'eas_unreadable'] as const
export type WarningCode = (typeof WARNING_CODES)[number]
export type RegimeWarning = { code: WarningCode; message: string }

export const SKIP_REASONS = ['no_scheme_vat', 'vat_exempt_b2b'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

export type SchemeBasis = {
  /** Who decided: the storefront plugin (adopted) or IMS (by value). */
  source: 'plugin' | 'ims'
  destination: string
  thresholdCurrency: 'EUR' | 'NOK'
  threshold: string
  /** The goods value in the order currency. */
  intrinsicValue: string
  /** The goods value in the threshold currency, rounded to the minor unit: IMS's own, else (adopt mode with no IMS rate) the plugin's; null when neither exists. */
  convertedValue: string | null
  /** IMS's order-date rate; null when none was available (only possible in adopt mode). */
  fx: { rate: string; sameCurrency: boolean; asOf: string; source: string } | null
  /** The plugin's recorded conversion, when it wrote one. */
  pluginFx: { recorded: true; rate: string; pair: string; thresholdValue: string } | { recorded: false; note: 'not recorded by the plugin' }
  vatTotal: string
  wooRateIds: number[]
  imsRateIds: string[]
  /** The zero-rated Xero type the order's goods, shipping and discount are posted on, recorded WITH the stamp (write-once) so a credit note reverses what the invoice used even if a rate's mapping moves later. Absent on a stamp written before it was kept. */
  schemePostingTaxType?: string
}

export type EuVatRegimeDecision =
  | { kind: 'SKIP'; reason: SkipReason; vatExemptB2b: boolean; warnings: RegimeWarning[] }
  | { kind: 'REFUSE'; code: RefusalCode; reason: string; /** With `gift_card_flag_missing`: the store ids of the lines whose flag is unsettled (those an operator can answer for). */ giftCardLineIds?: number[] }
  | {
      kind: 'SCHEME'
      regime: EuVatRegimeName
      /** The account code of the one VAT line. */
      vatAccount: string
      /** The collected VAT in the order currency (sum over the scheme rates). */
      vatAmount: string
      /** The zero-rated Xero TaxType the goods, shipping and discount lines post on. */
      schemePostingTaxType: string
      basis: SchemeBasis
      warnings: RegimeWarning[]
    }

export const normaliseDestination = (code: string | null | undefined): string => {
  const upper = (code ?? '').trim().toUpperCase()
  return upper === 'UK' ? 'GB' : upper === 'EL' ? 'GR' : upper
}

const refuse = (code: RefusalCode, reason: string): EuVatRegimeDecision => ({ kind: 'REFUSE', code, reason })
const category = (value: string | null): string => (value ?? '').trim().toUpperCase()
const isSchemeCategory = (value: string | null): boolean => ['IOSS', 'VOEC'].includes(category(value))
const roundMinor = (value: Decimal): Decimal => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

export function resolveEuVatRegime(input: EuVatRegimeInput): EuVatRegimeDecision {
  if (input.unreadable.length > 0) return refuse('order_figure_unreadable', `the order carries figures that cannot be read, so nothing can be decided: ${input.unreadable.join('; ')}`)
  if (input.giftCardFlag === 'setting_unreadable') return refuse('gift_card_cut_in_unreadable', 'the gift-card flag cut-in setting (or the order creation date) cannot be read, so it is not known whether this order must carry a gift-card flag on every line')
  if (input.giftCardFlag === 'required') {
    const missing = input.goodsLines.flatMap((line, index) => (line.voucherStrict === 'yes' || line.voucherStrict === 'no' ? [] : [index + 1]))
    if (missing.length > 0) {
      const giftCardLineIds = missing.flatMap((position) => { const id = input.goodsLines[position - 1]?.lineId; return id === undefined ? [] : [id] })
      return { ...refuse('gift_card_flag_missing', `the order was created after the gift-card flag cut-in but line(s) ${missing.join(', ')} carry no readable gift-card flag (_o3d_is_voucher yes/no). An operator can mark each such line as a gift card or not in Sync > Exceptions`), giftCardLineIds } as EuVatRegimeDecision
    }
  }
  const destination = normaliseDestination(input.shippingCountry) || normaliseDestination(input.billingCountry)
  const covered = SCHEME_DESTINATIONS.has(destination)
  const where = destination === '' ? '(nowhere)' : destination
  const moneyMin = D(MONEY_MOVED_MIN)

  // 1. Every rate that moved money. The tax evidence is looked at BEFORE the destination puts the order out of scope: a non-EU order carrying a scheme rate is a contradiction, not a skip.
  const otherMoney: string[] = []
  const qualifying: Array<{ fact: RateFact; mapped: Extract<RateMappingFact, { state: 'mapped' }>; country: string }> = []
  for (const fact of input.rates) {
    const tax = D(fact.tax)
    if (tax.abs().lt(moneyMin)) continue
    if (fact.mapping.state === 'unmapped') return refuse('rate_unmapped', `WooCommerce tax rate ${fact.wooRateId} charged ${tax.toFixed(2)} but is not mapped to an IMS rate, so the treatment cannot be established`)
    const mapped = fact.mapping
    if (!mapped.active) return refuse('rate_inactive', `WooCommerce tax rate ${fact.wooRateId} charged ${tax.toFixed(2)} and is mapped to the inactive IMS rate "${mapped.name}"`)
    const country = normaliseDestination(mapped.countryCode)
    const schemeCategory = isSchemeCategory(mapped.reportingCategory)
    const hasPostingType = (mapped.schemePostingTaxType ?? '').trim() !== ''
    if (schemeCategory !== hasPostingType) {
      return refuse('scheme_misconfigured', `IMS rate "${mapped.name}" has ${schemeCategory ? 'an IOSS/VOEC category but no scheme posting type' : 'a scheme posting type but no IOSS/VOEC category'}`)
    }
    if (schemeCategory) {
      qualifying.push({ fact, mapped, country })
      continue
    }
    const territories = DOMESTIC_TERRITORIES[country]
    if (territories !== undefined) {
      // A UK or Isle of Man rate is ordinary on its own territory and a contradiction anywhere else.
      if (tax.gt(0) && !territories.includes(destination)) return refuse('domestic_rate_abroad', `tax rate "${mapped.name}" (${country}) was charged on an order to ${where}, which is neither its own territory nor an EU sale`)
      otherMoney.push(`${mapped.name} ${tax.toFixed(2)}`)
      continue
    }
    // Q1: an EU, Monaco or Norway rate that moved money and is not on the scheme. No goods ship from EU stock, so this is never an OSS sale.
    if (SCHEME_DESTINATIONS.has(country) && D(mapped.rate).gt(0)) {
      return refuse('eu_rated_not_on_scheme', `tax rate "${mapped.name}" (${country}) charged ${tax.toFixed(2)} but is not an IOSS/VOEC scheme rate, and no goods ship from EU stock`)
    }
    otherMoney.push(`${mapped.name} ${tax.toFixed(2)}`)
  }

  // 2. A scheme rate on an order that is not going to a covered destination.
  if (qualifying.length > 0 && !covered) {
    return refuse('scheme_rate_outside_destination', `a scheme VAT rate for ${qualifying[0]!.country || '(no country)'} was charged but the order ships to ${where}`)
  }

  // 3. No scheme VAT.
  if (qualifying.length === 0) {
    if (covered && D(input.orderTax).abs().gt(moneyMin)) {
      return refuse('tax_without_scheme_rate', `WooCommerce charged ${D(input.orderTax).toFixed(2)} of tax to ${where} but no scheme rate could be identified`)
    }
    // An EU-27 order with no tax may be a business sale that is zero-rated. Whether it is depends on the exemption flag, so an unknown flag defers the order rather than stamping it as outside the scheme.
    if (EU27.has(destination) && input.vatExempt === 'unknown') {
      return refuse('vat_exempt_status_unknown', `the order ships to ${where} with no scheme VAT and its VAT-exempt (B2B) status is missing or unreadable, so it cannot be classed as outside the scheme`)
    }
    const exemptB2b = input.vatExempt === 'yes' && EU27.has(destination)
    return { kind: 'SKIP', reason: exemptB2b ? 'vat_exempt_b2b' : 'no_scheme_vat', vatExemptB2b: exemptB2b, warnings: [] }
  }

  const types = [...new Set(qualifying.map((q) => q.mapped.schemePostingTaxType!.trim()))]
  if (types.length > 1) return refuse('multiple_scheme_types', `the order carries more than one scheme posting type: ${types.join(', ')}`)
  const schemePostingTaxType = types[0]!

  for (const q of qualifying) {
    if (q.country !== destination) return refuse('rate_country_mismatch', `tax rate "${q.mapped.name}" belongs to ${q.country || '(no country)'} but the order ships to ${where}`)
    const expected = destination === 'NO' ? 'VOEC' : 'IOSS'
    if (category(q.mapped.reportingCategory) !== expected) {
      return refuse('rate_scheme_mismatch', `tax rate "${q.mapped.name}" is marked ${category(q.mapped.reportingCategory)} but a sale to ${destination} is ${expected}`)
    }
  }

  const vatTotal = qualifying.reduce((sum, q) => sum.plus(D(q.fact.tax)), D(0))

  if (input.vatExempt === 'yes') {
    return refuse('exempt_but_vat_charged', `the order is flagged VAT-exempt but ${vatTotal.toFixed(2)} of scheme VAT was charged`)
  }

  // Every pound of tax that moved money must be explained by the scheme rates: tax on any other rate, or a WooCommerce total that is not the scheme total, is unexplained and refuses.
  if (otherMoney.length > 0) {
    return refuse('tax_not_explained_by_scheme_rates', `tax moved on rates that are not scheme rates alongside ${vatTotal.toFixed(2)} on the scheme rates: ${otherMoney.join(', ')}`)
  }
  if (D(input.orderTax).minus(vatTotal).abs().gt(D(FIGURE_TOLERANCE))) {
    return refuse('tax_not_explained_by_scheme_rates', `WooCommerce's order tax is ${D(input.orderTax).toFixed(2)} but the scheme rates account for ${vatTotal.toFixed(2)}`)
  }

  // 4. The EU VAT record, when it is present and non-empty, is a cross-check: a mismatch refuses, its absence does not, and a non-empty record that cannot be read refuses.
  if (input.vatRecord.state === 'unreadable') return refuse('vat_record_unreadable', `the EU VAT record is present but cannot be read: ${input.vatRecord.detail}`)
  if (input.vatRecord.state === 'present') {
    if (input.vatRecord.currency !== null && input.vatRecord.currency !== input.currency) {
      return refuse('vat_record_currency_mismatch', `VAT is recorded in ${input.vatRecord.currency} but the order is in ${input.currency}`)
    }
    if (D(input.vatRecord.total).minus(vatTotal).abs().gt(D(FIGURE_TOLERANCE))) {
      return refuse('vat_record_mismatch', `the EU VAT record states ${D(input.vatRecord.total).toFixed(2)} but the order's tax lines on the scheme rates sum to ${vatTotal.toFixed(2)}`)
    }
  }

  // 5. The regime.
  const isNorway = destination === 'NO'
  const thresholdCurrency = isNorway ? 'NOK' : 'EUR'
  const threshold = D(isNorway ? VOEC_THRESHOLD_NOK : IOSS_THRESHOLD_EUR)
  const goodsExVoucher = input.goodsLines.filter((line) => line.voucher !== 'yes')
  const intrinsic = goodsExVoucher.reduce((sum, line) => sum.plus(D(line.total)), D(0))
  const fx = input.thresholdFx.state === 'ok' ? input.thresholdFx : null
  const converted = fx === null ? null : roundMinor(intrinsic.times(D(fx.rate)))
  const byValue: EuVatRegimeName | null = converted === null ? null : converted.gt(threshold) ? 'DDP' : isNorway ? 'VOEC' : 'IOSS'

  const warnings: RegimeWarning[] = []
  let regime: EuVatRegimeName
  if (input.mode === 'adopt_plugin') {
    // The plugin's decision, read from the account it recorded. Absent means the plugin has not handled this order: refuse, never guess.
    const recorded = (input.pluginVatAccount ?? '').trim()
    if (recorded === '') return refuse('plugin_account_missing', `the order has scheme VAT but the storefront plugin recorded no VAT account (_o3d_ioss_vat_account), so its decision cannot be adopted`)
    const ioss = (input.accounts.ioss ?? '').trim()
    const ddp = (input.accounts.ddp ?? '').trim()
    if (ioss === '' || ddp === '' || ioss === ddp) return refuse('vat_account_not_configured', 'the IOSS/VOEC and DDP VAT accounts must both be configured, and different, to adopt the plugin\'s decision')
    if (recorded === ioss) regime = isNorway ? 'VOEC' : 'IOSS'
    else if (recorded === ddp) regime = 'DDP'
    else return refuse('plugin_account_unrecognised', `the plugin recorded VAT account ${recorded}, which is neither the IOSS/VOEC account (${ioss}) nor the DDP account (${ddp})`)
    if (input.pluginFx.state === 'incomplete') return refuse('plugin_fx_incomplete', `the plugin recorded the VAT account but its conversion record is incomplete or unreadable: ${input.pluginFx.detail}`)
    if (input.pluginFx.state === 'present' && input.pluginFx.pair !== `${input.currency}>${thresholdCurrency}`) {
      return refuse('plugin_fx_conflict', `the plugin's conversion pair is ${input.pluginFx.pair} but this order converts ${input.currency}>${thresholdCurrency}, so its record does not belong to this decision`)
    }
    if (input.pluginFx.state === 'present') {
      // The plugin's own evidence must agree with itself and with the order. (1) Its recorded value selects its recorded account, as it compares: at the minor unit, strictly above the threshold is DDP. (2) Its rate applied to
      // the goods IMS sees must give its recorded value within rounding: PLUGIN_VALUE_TOLERANCE in the threshold currency. Goods lines with no gift-card flag may be gift cards the plugin left out, so the recorded value may
      // be anywhere between the known goods alone and all the unflagged goods too. A contradiction refuses; an order with no conversion record is exempt (before the plugin wrote one).
      const recordedValue = roundMinor(D(input.pluginFx.thresholdValue))
      if (recordedValue.gt(threshold) !== (regime === 'DDP')) {
        return refuse('plugin_evidence_contradicts', `the plugin recorded a goods value of ${recordedValue.toFixed(2)} ${thresholdCurrency} (${recordedValue.gt(threshold) ? 'over' : 'at or under'} ${threshold.toFixed(0)}) but VAT account ${recorded}, which is the ${regime === 'DDP' ? 'DDP' : 'IOSS/VOEC'} account`)
      }
      const pluginRate = D(input.pluginFx.rate)
      const high = roundMinor(intrinsic.times(pluginRate))
      const low = roundMinor(goodsExVoucher.filter((line) => line.voucher === 'no').reduce((sum, line) => sum.plus(D(line.total)), D(0)).times(pluginRate))
      const tol = D(PLUGIN_VALUE_TOLERANCE)
      if (recordedValue.lt(low.minus(tol)) || recordedValue.gt(high.plus(tol))) {
        return refuse('plugin_evidence_contradicts', `the plugin's rate ${input.pluginFx.rate} on this order's goods (${intrinsic.toFixed(2)} ${input.currency}) gives ${high.toFixed(2)} ${thresholdCurrency}${low.eq(high) ? '' : ` (${low.toFixed(2)} without the unflagged lines)`}, not the ${recordedValue.toFixed(2)} it recorded (tolerance ${PLUGIN_VALUE_TOLERANCE})`)
      }
    }
    if (input.pluginFxConflict) return refuse('plugin_fx_conflict', 'the plugin left differing FX meta unchanged when it recorded this decision, so the conversion on the order is not the one that decided it')
    if (byValue !== null && byValue !== regime) {
      warnings.push({ code: 'adopted_regime_differs', message: `the plugin's account says ${regime} but IMS's own order-date value test (${converted!.toFixed(2)} ${thresholdCurrency}) says ${byValue}; the plugin's decision is adopted` })
    }
  } else {
    if (fx === null || converted === null || byValue === null) {
      return refuse('threshold_value_unavailable', `cannot value the goods in ${thresholdCurrency} to apply the ${isNorway ? 'VOEC' : 'IOSS'} threshold: ${input.thresholdFx.state === 'unavailable' ? input.thresholdFx.reason : 'no rate'}`)
    }
    regime = byValue
    // A line with no gift-card flag counts as goods. If taking the unflagged lines out would change the outcome, the order's regime rests on a fact IMS does not have: refuse.
    const unknownLines = goodsExVoucher.filter((line) => line.voucher === 'unknown')
    if (unknownLines.length > 0) {
      const withoutUnknown = roundMinor(goodsExVoucher.filter((line) => line.voucher === 'no').reduce((sum, line) => sum.plus(D(line.total)), D(0)).times(D(fx.rate)))
      if (withoutUnknown.gt(threshold) !== converted.gt(threshold)) {
        return refuse('voucher_status_unknown', `${unknownLines.length} goods line(s) carry no gift-card flag and whether they are gift cards decides between ${isNorway ? 'VOEC' : 'IOSS'} and DDP`)
      }
    }
    if (converted.minus(threshold).abs().div(threshold).lte(D(THRESHOLD_WARN_BAND))) {
      warnings.push({
        code: 'threshold_band',
        message: `goods value ${converted.toFixed(2)} ${thresholdCurrency} is within 5% of the ${threshold.toFixed(0)} threshold: the order-date exchange rate decides whether this is ${isNorway ? 'VOEC' : 'IOSS'} or DDP, and the plugin's live rate may decide differently`,
      })
    }
  }
  const isDdp = regime === 'DDP'
  if (input.eas.state === 'unreadable') warnings.push({ code: 'eas_unreadable', message: `the EAS payload is present but its merchandise value cannot be read (${input.eas.detail}); the cross-check was not made` })
  if (input.eas.state === 'present' && input.eas.currency === input.currency && D(input.eas.merchandiseVatExcl).minus(intrinsic).abs().gt(D(FIGURE_TOLERANCE))) {
    warnings.push({ code: 'eas_disagrees', message: `goods value ${intrinsic.toFixed(2)} disagrees with the EAS figure ${D(input.eas.merchandiseVatExcl).toFixed(2)}` })
  }

  // 6. The account.
  let account: string
  if (input.mode === 'adopt_plugin') {
    account = (input.pluginVatAccount ?? '').trim()
  } else {
    account = ((isDdp ? input.accounts.ddp : input.accounts.ioss) ?? '').trim()
    if (account === '') return refuse('vat_account_not_configured', `no account is configured for the ${isDdp ? 'DDP VAT' : 'IOSS/VOEC VAT'} line`)
    if (input.pluginVatAccount !== null && input.pluginVatAccount.trim() !== '' && input.pluginVatAccount.trim() !== account) {
      warnings.push({ code: 'plugin_account_differs', message: `the storefront plugin recorded VAT account ${input.pluginVatAccount.trim()} on this order but IMS resolves ${account}` })
    }
  }

  // 7. Q6: the customs label decides by the presence of the over-threshold duty fee. Norway is left out: the label keeps VOEC possible with a prepaid fee there.
  if (!isNorway && isDdp !== input.overThresholdDutyFee) {
    warnings.push({
      code: 'label_regime_disagrees',
      message: isDdp
        ? 'accounting resolves DDP but the order carries no over-threshold duty fee, so the customs label will not treat it as DDP'
        : 'accounting resolves IOSS but the order carries an over-threshold duty fee, so the customs label will treat it as DDP',
    })
  }

  return {
    kind: 'SCHEME',
    regime,
    vatAccount: account,
    vatAmount: vatTotal.toString(),
    schemePostingTaxType,
    basis: {
      source: input.mode === 'adopt_plugin' ? 'plugin' : 'ims',
      destination,
      thresholdCurrency,
      threshold: threshold.toString(),
      intrinsicValue: intrinsic.toString(),
      convertedValue: converted !== null ? converted.toFixed(2) : input.pluginFx.state === 'present' ? input.pluginFx.thresholdValue : null,
      fx: fx === null ? null : { rate: fx.rate, sameCurrency: fx.sameCurrency, asOf: fx.asOf, source: fx.source },
      pluginFx: input.pluginFx.state === 'present'
        ? { recorded: true, rate: input.pluginFx.rate, pair: input.pluginFx.pair, thresholdValue: input.pluginFx.thresholdValue }
        : { recorded: false, note: 'not recorded by the plugin' },
      vatTotal: vatTotal.toString(),
      wooRateIds: qualifying.map((q) => q.fact.wooRateId).sort((a, b) => a - b),
      imsRateIds: [...new Set(qualifying.map((q) => q.mapped.imsRateId))].sort(),
      schemePostingTaxType,
    },
    warnings,
  }
}
