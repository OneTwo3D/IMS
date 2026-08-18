/**
 * o3d-w00 (Codex r3 #1): the VAT rate a hand-recorded refund allocation will ACTUALLY be re-grossed at
 * when its credit note posts — as opposed to the rate the order line nominally carries.
 *
 * The two are not the same thing, and the difference is money. `createSalesOrderRefund` snapshots each
 * refund line's `accountingTaxType` (resolveRefundLineTaxIdentity) and the credit-note payload posts the
 * NET line under that identity with `lineAmountsIncludeTax: false`, so the connector re-grosses at
 * whatever rate THAT tax code carries. The order line's own `TaxRate.rate` only coincides with it when
 * the line's TaxRate is mapped to an accounting tax code:
 *
 *   - a line whose TaxRate has NO accountingTaxType falls back to the ORDER-DEFAULT identity, exactly as
 *     the invoice did. A nominally 0% line on an order whose default is 20% therefore posts at 20% — so
 *     converting the operator's £100 gross at 0% stores £100 net and the credit note comes to £120,
 *     against a £100 storefront refund that "reconciled";
 *   - a reverse-charged line posts under `reverseChargeSalesTaxType`, which carries no seller VAT — but
 *     only when that setting is configured. Unconfigured, the swap does not happen and the line posts
 *     under its base code, which may be VAT-bearing;
 *   - shipping is unlinked and posts under the order-default identity, which resolves through an ACTIVE
 *     TaxRate named `SalesOrder.taxRateName`. A deactivated (or renamed) default leaves it with no
 *     identity at all.
 *
 * So the rate is resolved the way the posting resolves it, and the recording is REFUSED whenever that
 * cannot be done unambiguously, or whenever the resolved identity does not carry the rate the customer
 * was actually charged. Refusing is the only safe answer: the alternative is a credit note whose total
 * or whose VAT split silently disagrees with the refund it is supposed to settle — the exact failure the
 * quarantine exists to prevent.
 *
 * Every refusal names a remedy an operator (or an admin) can carry out — mapping the tax rate to an
 * accounting tax code, configuring the reverse-charge code, or reactivating the order's default rate —
 * after which the same row can be recorded.
 */

import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * TaxRate.rate and SalesOrder.taxRatePercent are both Decimal(5,4), so two rates that differ by less
 * than half of the last stored digit are the same rate.
 */
const RATE_EPSILON = 0.00005

export type PostedRefundTaxRate = {
  /** The line's own TaxRate (null for an unlinked shipping target, or an unrated line). */
  rate?: DecimalInput
  accountingTaxType?: string | null
  reverseCharge?: boolean | null
}

/**
 * What IMS knows a given accounting tax code to be worth: the set of DISTINCT rates carried by the
 * TaxRate rows mapped to it. One entry = an unambiguous rate; more than one = a configuration IMS may
 * not silently pick from; absent = a code IMS cannot price at all.
 */
export type TaxTypeRateIndex = Map<string, Set<string>>

export function buildTaxTypeRateIndex(
  taxRates: readonly { accountingTaxType?: string | null; rate?: DecimalInput }[],
): TaxTypeRateIndex {
  const index: TaxTypeRateIndex = new Map()
  for (const taxRate of taxRates) {
    const taxType = taxRate.accountingTaxType?.trim()
    if (!taxType) continue
    const rates = index.get(taxType) ?? new Set<string>()
    // Normalised through Decimal so 0.2000 and 0.2 are ONE rate, not two "conflicting" ones.
    rates.add(toDecimal(taxRate.rate ?? 0).toString())
    index.set(taxType, rates)
  }
  return index
}

export type PostedRefundTaxIdentity =
  | { ok: true; accountingTaxType: string; reverseCharge: boolean; vatRate: Decimal }
  | { ok: false; reason: string }

/**
 * Resolve the tax identity — and therefore the rate — a refund allocation against this target will post
 * under. Mirrors `resolveRefundLineTaxIdentity` in refund-service exactly, then prices the identity it
 * lands on from the TaxRate table.
 */
export function resolvePostedRefundTaxIdentity(input: {
  kind: 'sale' | 'shipping'
  /** The order line's TaxRate, for a `sale` target. Ignored for `shipping`. */
  lineTaxRate?: PostedRefundTaxRate | null
  /** accountingTaxType of the ACTIVE TaxRate named SalesOrder.taxRateName, or null. */
  orderDefaultTaxType: string | null
  /** SalesOrder.taxRatePercent — what the invoice charged shipping at. */
  orderDefaultRate?: DecimalInput
  /** settings.reverseChargeSalesTaxType ('' disables the swap). */
  reverseChargeSalesTaxType?: string | null
  rateByTaxType: TaxTypeRateIndex
  /** For the refusal messages: what this target is called on screen. */
  label: string
}): PostedRefundTaxIdentity {
  const isSale = input.kind === 'sale'
  const reverseCharge = isSale ? Boolean(input.lineTaxRate?.reverseCharge) : false
  const baseTaxType = isSale
    ? (input.lineTaxRate?.accountingTaxType ?? input.orderDefaultTaxType)
    : input.orderDefaultTaxType
  const accountingTaxType = resolveSalesLineTaxType({
    baseTaxType,
    reverseCharge,
    reverseChargeSalesTaxType: input.reverseChargeSalesTaxType,
  }) ?? null

  // The rate this part of the order was actually CHARGED at — what the customer paid, and what the
  // resolved identity has to agree with before the operator's gross may be divided by it.
  const chargedRate = isSale
    ? (reverseCharge ? toDecimal(0) : toDecimal(input.lineTaxRate?.rate ?? 0))
    : toDecimal(input.orderDefaultRate ?? 0)

  if (!accountingTaxType) {
    return {
      ok: false,
      reason: isSale
        ? `${input.label} has no accounting tax code — neither its own VAT rate nor the order's default ` +
          'rate is mapped to one, so the credit note has no identity to post it under. Map the tax rate ' +
          'to an accounting tax code in Settings → Tax Rates, then record this refund.'
        : `Shipping posts under the order's default VAT identity, and this order's default rate ` +
          '(taxRateName) is missing, renamed or deactivated, so there is no identity to post it under. ' +
          'Restore/map that tax rate in Settings → Tax Rates, then record this refund.',
    }
  }

  // The reverse-charge code carries NO seller VAT by definition (the customer accounts for it), so a
  // swapped line's gross IS its net. This is the identity the invoice posted the line under too.
  if (reverseCharge && input.reverseChargeSalesTaxType && accountingTaxType === input.reverseChargeSalesTaxType) {
    const rcRates = input.rateByTaxType.get(accountingTaxType)
    // If the reverse-charge code is ALSO mapped to a VAT-bearing tax rate, IMS is being told two
    // contradictory things about it; do not pick one.
    if (rcRates && [...rcRates].some((rate) => !toDecimal(rate).isZero())) {
      return {
        ok: false,
        reason:
          `${input.label} is reverse-charged, but the reverse-charge sales tax code ` +
          `(${accountingTaxType}) is also mapped to a VAT-bearing tax rate, so IMS cannot say what the ` +
          'credit note would be grossed up by. Fix the mapping in Settings → Tax Rates, then record ' +
          'this refund.',
      }
    }
    return { ok: true, accountingTaxType, reverseCharge: true, vatRate: toDecimal(0) }
  }

  const knownRates = input.rateByTaxType.get(accountingTaxType)
  if (!knownRates || knownRates.size === 0) {
    return {
      ok: false,
      reason:
        `${input.label} posts under accounting tax code ${accountingTaxType}, which no IMS tax rate is ` +
        'mapped to, so the rate its credit will be grossed up at is unknown. Map a tax rate to that ' +
        'code in Settings → Tax Rates, then record this refund.',
    }
  }
  if (knownRates.size > 1) {
    return {
      ok: false,
      reason:
        `${input.label} posts under accounting tax code ${accountingTaxType}, which IMS tax rates map to ` +
        `more than one rate (${[...knownRates].sort().join(', ')}), so the rate its credit will be ` +
        'grossed up at is ambiguous. Give those tax rates distinct accounting tax codes in Settings → ' +
        'Tax Rates, then record this refund.',
    }
  }
  const postedRate = toDecimal([...knownRates][0])
  if (postedRate.sub(chargedRate).abs().gt(RATE_EPSILON)) {
    return {
      ok: false,
      reason:
        `${input.label} was charged at ${chargedRate.mul(100).toString()}% but its credit note would ` +
        `post under accounting tax code ${accountingTaxType}, which is ${postedRate.mul(100).toString()}%` +
        (reverseCharge
          ? ' — the line is reverse-charged but no reverse-charge sales tax code is configured, so the ' +
            'swap the invoice relies on does not happen. Set it in Settings → Accounting, then record ' +
            'this refund.'
          : ' — so the credit note would restate VAT the customer was never charged. Map this line\'s ' +
            'tax rate to an accounting tax code that matches the rate it was sold at (Settings → Tax ' +
            'Rates), then record this refund.'),
    }
  }
  return { ok: true, accountingTaxType, reverseCharge, vatRate: postedRate }
}
