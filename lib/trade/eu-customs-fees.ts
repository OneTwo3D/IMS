/**
 * EU low-value-consignment customs fees, as a PURE rule: the EUR 3 flat-rate duty and the EUR 2 Union
 * handling fee (UHF).
 *
 * *** NOT WIRED IN. NOTHING CALLS THIS MODULE UNTIL THE SWITCHOVER. ***
 * WooCommerce (the wclc plugin) keeps CALCULATING these fees and IMS keeps MIRRORING the fee lines it
 * reports (standing ruling D5: IMS never recomputes). This file only prepares the rule, so that it exists,
 * is specified and is tested, for the day IMS becomes the order/fee source. It must not be imported by order
 * import, checkout or any push until then; the unit tests are its only caller.
 *
 * The rule mirrors wclc exactly (includes/class-wclc-hs-surcharge.php, class-wclc-union-handling-fee.php,
 * class-wclc-duty-fee.php, class-wclc-calculator.php), and tests/trade/eu-customs-fees.test.ts holds the
 * parity table built from wclc's own test cases. If wclc changes, this changes with it.
 *
 *   GATES      EU-27 destination only; private customers only (a business customer ships DDU: nothing here).
 *   UNITS      distinct HS codes (digits only, truncated to `hsDigits`, default 6; a line may carry several
 *              codes) + one per line with no usable code ("uncoded", counted line by line, switchable). It is
 *              NOT per SKU. The duty and the UHF share this one count.
 *   REGIME     consignment intrinsic value in EUR. At or below EUR 150 (strictly above is the other regime):
 *                - EUR 3 x units "EU Import Duty" and, from 2026-11-01 00:00 UTC, EUR 2 x units "EU Customs
 *                  Fee", as two separate fee lines. BOTH carry VAT at the destination STANDARD rate
 *                  (taxable lines; the VAT is WooCommerce's line tax, rounded half up to the cent).
 *              Above EUR 150 the duty is a Dutify quote and is NOT modelled here. Only the UHF is, from the same date,
 *              and WHERE it goes depends on what the Duty Fee could be priced from (`dutyFee.quote`), exactly as in
 *              wclc's WCLC_Duty_Fee::maybe_add_fee:
 *                - usable quote: the UHF is topped up onto the quote's one non-taxable Duty Fee line, GROSSED by the
 *                  destination standard VAT (net x (1 + rate)); on a line that is itself taxable it goes in NET (the
 *                  line's own VAT covers it). `uhfOverThreshold: 'dutify'` (Dutify's quote already holds it) turns
 *                  the top-up off, and ONLY here and in the "quote priced nothing" case.
 *                - no quote at all (duty off, Calcurates stand-down, no API key, the FX band just above the
 *                  threshold) or the quote priced nothing: a Duty Fee line holding the UHF ALONE, grossed, always
 *                  NON-taxable. Except "priced nothing", these ignore `uhfOverThreshold`: there is no quote to hold it.
 *                - quote unusable outside the band: the percent-of-goods fallback estimate plus the UHF
 *                  (`gross_amount`, whatever the mode says).
 *                - destination still a guess (deferred) or no request could be built: nothing is charged and the cart is
 *                  UNPRICED, with no UHF.
 *              The net of the UHF is recorded as the handling component, so duty + tax + handling = the line.
 *   UNKNOWN VALUE  a missing/unreadable consignment value is UNPRICED (wclc leaves the cart unpriced when it cannot
 *              express the value in the threshold currency), never read as 0 and so as the relieved regime.
 *   MONEY      exact decimals, EUR, half-up to the cent. Conversion into another order currency is the
 *              caller's, as it is in wclc (amounts are EUR-denominated there too).
 */
import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

export const EU_27_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

export type EuFeeConfig = {
  /** EUR per unit, flat-rate duty. wclc `amount_per_code`. */
  dutyPerUnit: string
  /** EUR per unit, Union handling fee. wclc `uhf_amount`. */
  uhfPerUnit: string
  /** Intrinsic-value threshold in EUR; strictly above it is the other regime. wclc `threshold`. */
  thresholdEur: string
  /** The UHF takes effect at this instant (00:00 UTC on 2026-11-01). wclc `uhf_effective`. */
  uhfEffective: Date
  /** wclc `hs_enabled`: the flat-rate duty is charged. */
  dutyEnabled: boolean
  /** wclc `uhf_enabled`. */
  uhfEnabled: boolean
  /** wclc `hs_digits`, clamped to 1..10. */
  hsDigits: number
  /** wclc `hs_charge_uncoded`: one unit per line with no usable code. */
  chargeUncoded: boolean
  /** wclc `duty_fallback_percent`: the percent-of-goods duty estimate when no usable quote could be had. */
  dutyFallbackPercent: string
  /** wclc `uhf_over_threshold`: 'wclc' tops the UHF up onto a usable quote, 'dutify' leaves it to the quote. */
  uhfOverThreshold: 'wclc' | 'dutify'
  /**
   * wclc `duty_tax_class` taxed (not the default). When the over-threshold duty line is itself taxable
   * WooCommerce adds the VAT, so the UHF goes in NET: grossing it up as well would tax it twice.
   */
  dutyFeeLineTaxable: boolean
}

export const UHF_EFFECTIVE_DEFAULT = new Date(Date.UTC(2026, 10, 1, 0, 0, 0))

export const DEFAULT_EU_FEE_CONFIG: EuFeeConfig = {
  dutyPerUnit: '3',
  uhfPerUnit: '2',
  thresholdEur: '150',
  uhfEffective: UHF_EFFECTIVE_DEFAULT,
  dutyEnabled: true,
  uhfEnabled: true,
  hsDigits: 6,
  chargeUncoded: true,
  dutyFallbackPercent: '2',
  uhfOverThreshold: 'wclc',
  dutyFeeLineTaxable: false,
}

export type EuFeeLineInput = {
  /** Every HS code the line's product carries (a product may carry several), raw as stored. */
  hsCodes: readonly string[]
}

/**
 * What the Duty Fee (above the threshold) could be priced from, as wclc's Dutify client reports it:
 * `usable` a quote; `none` Dutify priced nothing (an answer); `unconfigured` no API key; `unusable` no usable figure (API
 * failure); `deferred` the destination is still a geolocation guess; `no_request` the cart could not be described to ask.
 */
export type DutyQuoteState = 'usable' | 'none' | 'unconfigured' | 'unusable' | 'deferred' | 'no_request'

export type DutyFeeContext = {
  /** wclc `duty_enabled` (default true). Off: the UHF is still owed, alone. */
  dutyEnabled?: boolean
  /** Calcurates already folds the duty into shipping (the stand-down): the UHF is still owed, alone. */
  calcuratesStandDown?: boolean
  /** Default `usable`. */
  quote?: DutyQuoteState
}

export type EuFeeInput = {
  destinationCountry: string
  customer: 'private' | 'business'
  /**
   * Consignment intrinsic value in EUR (goods actually paid, post-discount, ex-VAT: wclc `goods_ex_tax`). REQUIRED: null,
   * undefined, empty or unreadable gives an `unpriced` result, never the relieved regime.
   */
  consignmentValueEur: DecimalInput | undefined
  /** Only read above the threshold. */
  dutyFee?: DutyFeeContext
  lines: readonly EuFeeLineInput[]
  /** When the order is placed (the UHF date gate is judged on this instant). */
  at: Date
  /** Destination STANDARD-class VAT rate as a percentage (21 for 21%), or null when none is configured. */
  standardVatRatePercent: DecimalInput | null
  config?: Partial<EuFeeConfig>
}

export type EuFeeAmounts = {
  /** Net fee, EUR. */
  net: Decimal
  /** VAT WooCommerce adds to a TAXABLE fee line (zero on the over-threshold line, where VAT is inside gross). */
  vat: Decimal
}

export type OverThresholdUhf = {
  /** The amount the UHF adds: net x (1 + VAT) where grossed, else the net. */
  gross: Decimal
  /** The UHF net (`_wclc_handling_component`). */
  handlingComponent: Decimal
  /** gross - net: belongs to `_wclc_tax_component`. */
  taxPart: Decimal
  /**
   * Where it lands: `quote_line` topped onto the usable quote's Duty Fee line; `uhf_only_line` a Duty Fee line holding
   * the UHF alone (always non-taxable); `fallback_line` on the percent-of-goods fallback line.
   */
  placement: 'quote_line' | 'uhf_only_line' | 'fallback_line'
  /** Whether the line it lands on is taxable (a UHF-only line never is). */
  lineTaxable: boolean
}

export type EuFeeResult = {
  regime: 'not_applicable' | 'unpriced' | 'flat_rate' | 'over_threshold'
  /** Why nothing applies or the cart is unpriced. */
  reason?: 'not_eu_27' | 'business_customer' | 'destination_unknown' | 'value_unknown' | 'destination_deferred' | 'no_request'
  distinctHsCodes: number
  uncodedLines: number
  /** The shared unit count: distinct codes + (when charged) uncoded lines. */
  units: number
  /** "EU Import Duty" fee line (flat_rate only), taxable. Null when not owed. */
  duty: EuFeeAmounts | null
  /** "EU Customs Fee" fee line (flat_rate only), taxable. Null when not owed. */
  uhf: EuFeeAmounts | null
  /** over_threshold only: the UHF and where it lands. The Dutify duty itself is NOT modelled. Null when not owed. */
  overThresholdUhf: OverThresholdUhf | null
  /** over_threshold, `unusable` outside the band, percent above zero: the percent-of-goods duty estimate (EUR). */
  dutyEstimate: Decimal | null
  /** over_threshold, grossing wanted, but no standard rate configured: wclc adds the fee net and warns. */
  vatRateMissing: boolean
}

function clampDigits(value: number): number {
  const n = Math.trunc(Number.isFinite(value) ? value : 0)
  return Math.min(10, Math.max(1, n))
}

function cents(value: DecimalInput): Decimal {
  return roundQuantity(value, 2)
}

/** The distinct-code and uncoded-line counts: wclc `count_distinct_hs_codes` / `count_uncoded_line_items`. */
export function countCustomsUnits(
  lines: readonly EuFeeLineInput[],
  options: { hsDigits?: number; chargeUncoded?: boolean } = {},
): { distinctHsCodes: number; uncodedLines: number; units: number } {
  const digits = clampDigits(options.hsDigits ?? DEFAULT_EU_FEE_CONFIG.hsDigits)
  const prefixes = new Set<string>()
  let uncodedLines = 0
  for (const line of lines) {
    let usable = false
    for (const raw of line.hsCodes) {
      const code = String(raw).replace(/\D/g, '')
      if (code === '') continue
      usable = true
      // Shorter than `digits`: the whole code still counts, as wclc's substr does.
      prefixes.add(code.slice(0, digits))
    }
    if (!usable) uncodedLines += 1
  }
  const chargeUncoded = options.chargeUncoded ?? DEFAULT_EU_FEE_CONFIG.chargeUncoded
  return {
    distinctHsCodes: prefixes.size,
    uncodedLines,
    units: prefixes.size + (chargeUncoded ? uncodedLines : 0),
  }
}

/** Whether the UHF is switched on and has taken effect at `at` (inclusive of the effective instant). */
export function isUhfLive(at: Date, config: Pick<EuFeeConfig, 'uhfEnabled' | 'uhfEffective'> = DEFAULT_EU_FEE_CONFIG): boolean {
  return config.uhfEnabled && at.getTime() >= config.uhfEffective.getTime()
}

/** A present, finite, non-negative EUR value, or null. */
function readConsignmentValue(value: DecimalInput | undefined): Decimal | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  try {
    const d = toDecimal(value)
    return d.isNegative() ? null : d
  } catch {
    return null
  }
}

const ROUNDING_TOLERANCE = toDecimal('0.01')
/** wclc `FALLBACK_BAND_PERCENT`: just above the threshold, where the duty fallback is suppressed. */
const FALLBACK_BAND_PERCENT = 2

export function computeEuCustomsFees(input: EuFeeInput): EuFeeResult {
  const config: EuFeeConfig = { ...DEFAULT_EU_FEE_CONFIG, ...input.config }
  const none = (regime: EuFeeResult['regime'], reason: NonNullable<EuFeeResult['reason']>, counts?: ReturnType<typeof countCustomsUnits>): EuFeeResult => ({
    regime, reason, distinctHsCodes: counts?.distinctHsCodes ?? 0, uncodedLines: counts?.uncodedLines ?? 0, units: counts?.units ?? 0,
    duty: null, uhf: null, overThresholdUhf: null, dutyEstimate: null, vatRateMissing: false,
  })

  const country = (input.destinationCountry ?? '').trim().toUpperCase()
  // wclc: an EMPTY destination (a guest on the cart page, an express sheet before its address callback) is the cart
  // that was never priced, not a deliberate non-charge. Only a known non-EU country is "not applicable".
  if (!/^[A-Z]{2}$/.test(country)) return none('unpriced', 'destination_unknown')
  if (!EU_27_COUNTRIES.has(country)) return none('not_applicable', 'not_eu_27')
  if (input.customer === 'business') return none('not_applicable', 'business_customer')

  const counts = countCustomsUnits(input.lines, config)
  const value = readConsignmentValue(input.consignmentValueEur)
  // wclc: a value that cannot be expressed in the threshold currency leaves the cart unpriced - charging either regime would be a guess.
  if (value === null) return none('unpriced', 'value_unknown', counts)

  const units = toDecimal(counts.units)
  const ratePercent = input.standardVatRatePercent == null ? null : toDecimal(input.standardVatRatePercent)
  const rate = ratePercent !== null && ratePercent.gt(0) ? ratePercent : null
  const dutyUnit = toDecimal(config.dutyPerUnit)
  const uhfUnit = toDecimal(config.uhfPerUnit)
  const uhfOwed = isUhfLive(input.at, config) && counts.units > 0 && uhfUnit.gt(0)
  const vatOn = (net: Decimal): Decimal => (rate === null ? toDecimal(0) : cents(net.mul(rate).div(100)))
  const threshold = toDecimal(config.thresholdEur)

  // Strictly above the threshold is the Duty Fee regime; exactly on it is still relieved.
  if (value.gt(threshold)) {
    const ctx = input.dutyFee ?? {}
    const quote: DutyQuoteState = ctx.quote ?? 'usable'
    const base = { ...none('over_threshold', 'value_unknown', counts), reason: undefined }
    const unpriced = (reason: 'destination_deferred' | 'no_request'): EuFeeResult => ({ ...none('unpriced', reason, counts) })

    const net = cents(uhfUnit.mul(units))
    // gross_amount(cart, gross): net x (1 + rate) when grossing and a standard rate exists, else the net (with a warning).
    const grossed = (gross: boolean) => {
      const missing = gross && rate === null
      const amount = gross && rate !== null ? cents(uhfUnit.mul(units).mul(toDecimal(1).add(rate.div(100)))) : net
      return { amount, missing }
    }
    const make = (amount: Decimal, missing: boolean, placement: OverThresholdUhf['placement'], lineTaxable: boolean): OverThresholdUhf => ({
      gross: amount, handlingComponent: net, taxPart: amount.sub(net), placement, lineTaxable,
    })
    /** charge_uhf_only: a Duty Fee line holding the UHF alone, non-taxable; not charged at or under a cent. */
    const uhfOnly = (amount: number | Decimal, missing: boolean): EuFeeResult => {
      const a = toDecimal(amount)
      if (!uhfOwed || a.lte(ROUNDING_TOLERANCE)) return { ...base, overThresholdUhf: null }
      return { ...base, overThresholdUhf: make(a, missing, 'uhf_only_line', false), vatRateMissing: missing }
    }
    // The top-up onto a usable quote: gross on a non-taxable line, net on a taxable one; nothing in 'dutify' mode.
    const topUp = (): { amount: Decimal; missing: boolean } | null => {
      if (!uhfOwed || config.uhfOverThreshold === 'dutify') return null
      return grossed(!config.dutyFeeLineTaxable)
    }

    // Paths that price no duty at all and so owe the UHF alone (wclc: charge_uhf_only(cart, true)): grossed whatever the mode says.
    const noQuoteUhf = () => { const g = grossed(true); return uhfOnly(g.amount, g.missing) }

    if (ctx.dutyEnabled === false || ctx.calcuratesStandDown === true) return noQuoteUhf()

    switch (quote) {
      case 'unconfigured':
        return noQuoteUhf()
      case 'deferred':
      case 'no_request':
        return unpriced(quote === 'deferred' ? 'destination_deferred' : 'no_request')
      case 'none': {
        // Dutify priced nothing: the UHF is still due where the mode allows it (top_up), grossed, on its own line.
        const t = topUp()
        // A top-up always grosses here (wclc calls top_up($cart) with the default), whatever duty_tax_class says.
        if (t === null) return { ...base, overThresholdUhf: null }
        const g = grossed(true)
        return uhfOnly(g.amount, g.missing)
      }
      case 'unusable': {
        const bandTop = threshold.mul(toDecimal(1).add(toDecimal(FALLBACK_BAND_PERCENT).div(100)))
        if (threshold.gt(0) && value.gte(threshold) && value.lte(bandTop)) return noQuoteUhf() // the FX band: no duty estimate, UHF alone
        // The percent-of-goods fallback estimate (duty alone) plus the UHF, whatever the over-threshold mode says.
        const percent = toDecimal(config.dutyFallbackPercent)
        // THE RULE: whenever the UHF ends up on a NON-taxable line it is grossed by the standard VAT (nothing taxes it
        // afterwards); it goes in NET only on a line that is actually taxed. A UHF-only line is never taxable.
        const alone = grossed(true)
        const aloneAmount = uhfOwed ? alone.amount : toDecimal(0)
        const onLine = grossed(!config.dutyFeeLineTaxable)
        const onLineAmount = uhfOwed ? onLine.amount : toDecimal(0)
        const aloneResult = (): EuFeeResult =>
          aloneAmount.gt(ROUNDING_TOLERANCE)
            ? { ...base, overThresholdUhf: make(aloneAmount, alone.missing, 'uhf_only_line', false), vatRateMissing: alone.missing }
            : { ...base, overThresholdUhf: null }
        if (percent.lte(0)) return aloneResult()
        const estimate = cents(value.mul(percent).div(100))
        if (estimate.lte(ROUNDING_TOLERANCE)) return aloneResult()
        return {
          ...base,
          dutyEstimate: estimate,
          overThresholdUhf: onLineAmount.gt(0) ? make(onLineAmount, onLine.missing, 'fallback_line', config.dutyFeeLineTaxable) : null,
          vatRateMissing: onLineAmount.gt(0) && onLine.missing,
        }
      }
      case 'usable':
      default: {
        const t = topUp()
        if (t === null) return { ...base, overThresholdUhf: null }
        return { ...base, overThresholdUhf: make(t.amount, t.missing, 'quote_line', config.dutyFeeLineTaxable), vatRateMissing: t.missing }
      }
    }
  }

  const dutyNet = config.dutyEnabled && counts.units > 0 && dutyUnit.gt(0) ? cents(dutyUnit.mul(units)) : null
  const uhfNet = uhfOwed ? cents(uhfUnit.mul(units)) : null
  return {
    regime: 'flat_rate',
    ...counts,
    duty: dutyNet === null ? null : { net: dutyNet, vat: vatOn(dutyNet) },
    uhf: uhfNet === null ? null : { net: uhfNet, vat: vatOn(uhfNet) },
    overThresholdUhf: null,
    dutyEstimate: null,
    vatRateMissing: false,
  }
}
