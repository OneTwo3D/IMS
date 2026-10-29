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
 *              Above EUR 150 the duty is a Dutify quote and is NOT modelled here. Only the UHF is (from the
 *              same date): it is folded into the one non-taxable duty line GROSSED by the destination's
 *              standard VAT (net x (1 + rate)), with the net recorded as the handling component, so that
 *              duty + tax + handling = the line. `uhfOverThreshold: 'dutify'` switches that top-up off.
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
  /** wclc `uhf_over_threshold`: 'wclc' adds the UHF above the threshold, 'dutify' leaves it to the quote. */
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
  uhfOverThreshold: 'wclc',
  dutyFeeLineTaxable: false,
}

export type EuFeeLineInput = {
  /** Every HS code the line's product carries (a product may carry several), raw as stored. */
  hsCodes: readonly string[]
}

export type EuFeeInput = {
  destinationCountry: string
  customer: 'private' | 'business'
  /** Consignment intrinsic value in EUR (goods actually paid, post-discount, ex-VAT: wclc `goods_ex_tax`). */
  consignmentValueEur: DecimalInput
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

export type EuFeeResult = {
  regime: 'not_applicable' | 'flat_rate' | 'over_threshold'
  /** Why nothing applies (regime 'not_applicable' only). */
  reason?: 'not_eu_27' | 'business_customer'
  distinctHsCodes: number
  uncodedLines: number
  /** The shared unit count: distinct codes + (when charged) uncoded lines. */
  units: number
  /** "EU Import Duty" fee line (flat_rate only), taxable. Null when not owed. */
  duty: EuFeeAmounts | null
  /** "EU Customs Fee" fee line (flat_rate only), taxable. Null when not owed. */
  uhf: EuFeeAmounts | null
  /**
   * over_threshold only: what is added to the Duty Fee line for the UHF. `gross` is the amount added to the line
   * (net x (1 + VAT) on a non-taxable line, net on a taxable one); `handlingComponent` is the net
   * (`_wclc_handling_component`); `taxPart` is gross - net (it belongs to `_wclc_tax_component`).
   * The Dutify duty itself is NOT modelled. Null when not owed.
   */
  overThresholdUhf: { gross: Decimal; handlingComponent: Decimal; taxPart: Decimal } | null
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

export function computeEuCustomsFees(input: EuFeeInput): EuFeeResult {
  const config: EuFeeConfig = { ...DEFAULT_EU_FEE_CONFIG, ...input.config }
  const empty = (reason: 'not_eu_27' | 'business_customer'): EuFeeResult => ({
    regime: 'not_applicable', reason, distinctHsCodes: 0, uncodedLines: 0, units: 0,
    duty: null, uhf: null, overThresholdUhf: null, vatRateMissing: false,
  })

  const country = input.destinationCountry.trim().toUpperCase()
  if (!EU_27_COUNTRIES.has(country)) return empty('not_eu_27')
  if (input.customer === 'business') return empty('business_customer')

  const counts = countCustomsUnits(input.lines, config)
  const units = toDecimal(counts.units)
  const ratePercent = input.standardVatRatePercent == null ? null : toDecimal(input.standardVatRatePercent)
  const rate = ratePercent !== null && ratePercent.gt(0) ? ratePercent : null
  const dutyUnit = toDecimal(config.dutyPerUnit)
  const uhfUnit = toDecimal(config.uhfPerUnit)
  const uhfOwed = isUhfLive(input.at, config) && counts.units > 0 && uhfUnit.gt(0)
  const vatOn = (net: Decimal): Decimal => (rate === null ? toDecimal(0) : cents(net.mul(rate).div(100)))

  // Strictly above the threshold is the Duty Fee regime; exactly on it is still relieved.
  if (toDecimal(input.consignmentValueEur).gt(toDecimal(config.thresholdEur))) {
    let overThresholdUhf: EuFeeResult['overThresholdUhf'] = null
    let vatRateMissing = false
    if (uhfOwed && config.uhfOverThreshold === 'wclc') {
      const net = cents(uhfUnit.mul(units))
      const grossUp = !config.dutyFeeLineTaxable
      vatRateMissing = grossUp && rate === null
      const gross = grossUp && rate !== null ? cents(uhfUnit.mul(units).mul(toDecimal(1).add(rate.div(100)))) : net
      overThresholdUhf = { gross, handlingComponent: net, taxPart: gross.sub(net) }
    }
    return { regime: 'over_threshold', ...counts, duty: null, uhf: null, overThresholdUhf, vatRateMissing }
  }

  const dutyNet = config.dutyEnabled && counts.units > 0 && dutyUnit.gt(0) ? cents(dutyUnit.mul(units)) : null
  const uhfNet = uhfOwed ? cents(uhfUnit.mul(units)) : null
  return {
    regime: 'flat_rate',
    ...counts,
    duty: dutyNet === null ? null : { net: dutyNet, vat: vatOn(dutyNet) },
    uhf: uhfNet === null ? null : { net: uhfNet, vat: vatOn(uhfNet) },
    overThresholdUhf: null,
    vatRateMissing: false,
  }
}
