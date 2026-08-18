/**
 * o3d-w00 (Codex r3 #1): the VAT rate a hand-recorded refund allocation will ACTUALLY be re-grossed at
 * when its credit note posts — as opposed to the rate the order line nominally carries.
 *
 * The two are not the same thing, and the difference is money. `createSalesOrderRefund` snapshots each
 * refund line's `accountingTaxType` (resolveRefundLineTaxIdentity) and the credit-note payload posts the
 * NET line under that identity with `lineAmountsIncludeTax: false`, so the connector re-grosses at
 * whatever rate THAT tax code carries. The order line's own tax rate only coincides with it when the
 * line's TaxRate is mapped to an accounting tax code:
 *
 *   - a line whose TaxRate has NO accountingTaxType falls back to the ORDER-DEFAULT identity, exactly as
 *     the invoice did. A nominally 0% line on an order whose default is 20% therefore posts at 20% — so
 *     converting the operator's £100 gross at 0% stores £100 net and the credit note comes to £120,
 *     against a £100 storefront refund that "reconciled";
 *   - a line with NO TaxRate row at all is not line-linked for tax purposes at all: refund-service falls
 *     through to the order's single safe identity, which exists only on a uniformly taxed order;
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
 * ---------------------------------------------------------------------------------------------------
 * Codex r4 #1: WHAT THE LINE WAS CHARGED IS A HISTORICAL FACT, AND ONLY THE ORDER RECORDS IT.
 *
 * The divergence check added in r3 compared the identity's rate against `TaxRate.rate` — the LIVE,
 * mutable rate row the line points at. That is the same class of defect as the bug it was added to
 * catch, one level up: r3 read a stored fraction as a percentage, and r3's own check read a CURRENT
 * value as a HISTORICAL one. An admin who edits a VAT rate (or flips its reverseCharge flag) silently
 * rewrites what every past order "was charged", and the check then compares today's rate against
 * today's rate and always agrees — while the credit note re-grosses at the new rate and the VAT split
 * on a refund of an old order is quietly wrong.
 *
 * The order's OWN snapshot of what it charged is the only honest source, and IMS has one for every
 * money-bearing part of an order:
 *
 *   - a sale line: `SalesOrderLine.totalForeign` (the NET it was sold at) and `SalesOrderLine.taxForeign`
 *     (the VAT taken on it). Both are written once, in the order's currency, by createSalesOrder and by
 *     the WooCommerce importer — taxForeign on an imported order is WooCommerce's own `total_tax`, i.e.
 *     literally what the customer paid. The rate charged is taxForeign / totalForeign;
 *   - shipping: `SalesOrder.taxRatePercent`, an order column written alongside the money at creation /
 *     import. It is already a snapshot — it is not read back through the TaxRate table — so the
 *     historical/current distinction does not arise on that path.
 *
 * Where a sale line carries no such snapshot (no stored net, or a net of zero, or figures too small to
 * pin a rate down to better than a tenth of a percentage point), the answer is NOT to substitute the
 * live rate. It is to say so and refuse, naming what the operator can do instead.
 *
 * Codex r4 #3: an UNMAPPED accounting tax code is not evidence of anything either. The r3 code returned
 * a 0% rate for a reverse-charge code that no IMS tax rate is mapped to, on the reasoning that reverse
 * charge carries no seller VAT — but IMS does not store that, and `resolveSalesLineTaxType` only swaps
 * the CODE, it knows nothing about the code's rate. Assuming zero converts the operator's gross as if no
 * VAT were charged. Every identity, reverse-charge included, is now priced from the tax table or
 * refused.
 * ---------------------------------------------------------------------------------------------------
 *
 * Every refusal names a remedy an operator (or an admin) can carry out — mapping the tax rate to an
 * accounting tax code, mapping a 0% rate to the reverse-charge code, configuring the reverse-charge
 * code, reactivating the order's default rate, or allocating the money to the part of the order it
 * actually came off — after which the same row can be recorded.
 */

import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * TaxRate.rate and SalesOrder.taxRatePercent are both Decimal(5,4), so two rates that differ by less
 * than half of the last stored digit are the same rate. Exported because the posting side re-prices the
 * identity under the order lock and has to use the same notion of "the same rate" (Codex r4 #2).
 */
export const RATE_EPSILON = 0.00005

/** Half of the last digit of Decimal(18,4) — the storage precision of every stored money figure. */
const MONEY_HALF_UNIT = 0.00005

/**
 * A rate DERIVED from two independently rounded money figures carries their rounding, and on a small
 * line that uncertainty grows without bound (a 1p line pins its rate down to nothing at all). Past this
 * width the comparison could no longer tell 19% from 20%, which is precisely what it exists to do, so
 * the line is treated as carrying no usable snapshot rather than being waved through on a tolerance
 * wide enough to hide the defect. 0.1 of a percentage point is well inside the smallest gap between two
 * real VAT rates.
 */
const MAX_DERIVED_RATE_TOLERANCE = 0.001

/**
 * The identity-bearing fields of the TaxRate row an order line points at. Deliberately does NOT carry
 * `rate`: the live rate is not what the line was charged at, and a type that cannot express it is how
 * the r3 defect is kept from coming back. `reverseCharge` is read for the CODE SWAP only (that is what
 * the posting does with it too) — never as a claim that no VAT was charged, which is answered by the
 * line's own money snapshot.
 */
export type PostedRefundTaxRate = {
  accountingTaxType?: string | null
  reverseCharge?: boolean | null
}

/**
 * The order line's own record of what it was charged, in the order's currency: the NET it was sold at
 * and the VAT taken on it. Both are Decimal(18,4) columns on SalesOrderLine, written once at creation /
 * import and never re-derived from the tax table.
 *
 * `undefined` means the caller did not read the figure — which is NOT the same as zero, and must never
 * be read as "no VAT was charged".
 */
export type ChargedLineSnapshot = {
  netForeign?: DecimalInput
  taxForeign?: DecimalInput
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

/**
 * The order's single safe posting identity, mirroring createSalesOrderRefund exactly (o3d-w00 #5 /
 * Codex r3 #4): the EFFECTIVE, post-swap identity of every line, which is what an UNLINKED sale amount
 * posts under. Present only when all lines resolve to one non-null identity and the reverse-charge swap
 * is available wherever it is needed.
 *
 * Codex r4 #2: this exists so the pre-flight resolves the identity of a line with NO TaxRate row the
 * same way the posting does. It used to fall back to the order default here and to this on the posting
 * side, so the two reads could disagree about the identity by construction, not merely by racing.
 */
export function resolveOrderUniformTaxIdentity(input: {
  lines: readonly { taxRate?: PostedRefundTaxRate | null }[]
  reverseChargeSalesTaxType?: string | null
}): { singleSafeTaxType: string | null; uniformlyReverseCharged: boolean } {
  const reverseChargedLineCount = input.lines.filter((line) => line.taxRate?.reverseCharge).length
  const reverseChargeSwapUnavailable = reverseChargedLineCount > 0 && !input.reverseChargeSalesTaxType
  const effectiveTaxTypes = new Set(input.lines.map((line) => resolveSalesLineTaxType({
    baseTaxType: line.taxRate?.accountingTaxType ?? null,
    reverseCharge: line.taxRate?.reverseCharge,
    reverseChargeSalesTaxType: input.reverseChargeSalesTaxType,
  }) ?? null))
  const uniformlyTaxed = effectiveTaxTypes.size === 1 &&
    !effectiveTaxTypes.has(null) &&
    !reverseChargeSwapUnavailable
  return {
    singleSafeTaxType: uniformlyTaxed ? ([...effectiveTaxTypes][0] as string) : null,
    uniformlyReverseCharged: uniformlyTaxed &&
      reverseChargedLineCount === input.lines.length &&
      reverseChargedLineCount > 0,
  }
}

export type PostedRefundTaxIdentity =
  | { ok: true; accountingTaxType: string; reverseCharge: boolean; vatRate: Decimal }
  | { ok: false; reason: string }

type ChargedRate =
  | { ok: true; rate: Decimal; tolerance: number }
  | { ok: false; detail: string }

/**
 * The rate a sale line was CHARGED at, from its own money snapshot. Never from the tax table.
 *
 * The derived rate inherits the rounding of both stored figures: each is held to Decimal(18,4), so
 * `rate = tax / net` carries at most (halfUnit + rate x halfUnit) / net of error. That is the tolerance
 * the comparison is entitled to — no wider (which would hide a real rate difference) and no narrower
 * (which would refuse a legitimate small line for its own stored rounding).
 */
function chargedRateFromSnapshot(snapshot: ChargedLineSnapshot | null | undefined): ChargedRate {
  if (snapshot?.netForeign == null || snapshot.taxForeign == null) {
    return { ok: false, detail: 'IMS holds no record of the net it was sold at and the VAT taken on it' }
  }
  const net = toDecimal(snapshot.netForeign)
  const tax = toDecimal(snapshot.taxForeign)
  if (net.lte(0)) {
    return { ok: false, detail: `it carries no net amount (${net.toFixed(4)}), so no rate can be read off it` }
  }
  const rate = tax.div(net)
  // (1 + rate) x halfUnit / net, evaluated with the derived rate itself — accurate enough for a bound.
  const tolerance = toDecimal(MONEY_HALF_UNIT).mul(toDecimal(1).add(rate.abs())).div(net).toNumber()
  if (tolerance > MAX_DERIVED_RATE_TOLERANCE) {
    return {
      ok: false,
      detail:
        `its stored amounts (${tax.toFixed(4)} of VAT on a net of ${net.toFixed(4)}) are too small to fix ` +
        'the rate it was charged at to better than a tenth of a percentage point',
    }
  }
  return { ok: true, rate, tolerance: Math.max(RATE_EPSILON, tolerance) }
}

/**
 * The rate a sale line was charged at, for DISPLAY on a target the action has refused — so the row
 * still reads truthfully (what the customer paid) instead of showing a live rate that is not what the
 * line was sold at and is not what its credit would post at either. Null when the snapshot cannot say.
 */
export function chargedRateFromLineSnapshot(snapshot: ChargedLineSnapshot | null | undefined): Decimal | null {
  const charged = chargedRateFromSnapshot(snapshot)
  return charged.ok ? charged.rate : null
}

/**
 * Resolve the tax identity — and therefore the rate — a refund allocation against this target will post
 * under. Mirrors `resolveRefundLineTaxIdentity` in refund-service exactly, prices the identity it lands
 * on from the TaxRate table, and checks that price against what the ORDER says this part of it was
 * charged.
 */
export function resolvePostedRefundTaxIdentity(input: {
  kind: 'sale' | 'shipping'
  /** The TaxRate ROW linked to the order line, for a `sale` target. Null when the line has none. */
  lineTaxRate?: PostedRefundTaxRate | null
  /** The order line's own money snapshot, for a `sale` target. Ignored for `shipping`. */
  chargedLine?: ChargedLineSnapshot | null
  /** accountingTaxType of the ACTIVE TaxRate named SalesOrder.taxRateName, or null. */
  orderDefaultTaxType: string | null
  /**
   * SalesOrder.taxRatePercent — the ORDER's own snapshot of the rate it charged shipping at. An order
   * column, not a read of the live TaxRate row, so it is already historical (Codex r4 #1).
   */
  orderChargedRate?: DecimalInput
  /** The order's single safe identity, for a sale line that has no TaxRate row of its own. */
  orderUniform?: { singleSafeTaxType: string | null; uniformlyReverseCharged: boolean }
  /** settings.reverseChargeSalesTaxType ('' disables the swap). */
  reverseChargeSalesTaxType?: string | null
  rateByTaxType: TaxTypeRateIndex
  /** For the refusal messages: what this target is called on screen. */
  label: string
}): PostedRefundTaxIdentity {
  const isSale = input.kind === 'sale'
  // A sale line with NO TaxRate row is not line-linked for tax at all: refund-service falls through to
  // the order's single safe identity for it, so the pre-flight must too, or the two reads disagree by
  // construction (Codex r4 #2).
  const unlinkedSale = isSale && !input.lineTaxRate
  const reverseCharge = isSale
    ? (unlinkedSale
        ? Boolean(input.orderUniform?.uniformlyReverseCharged)
        : Boolean(input.lineTaxRate?.reverseCharge))
    : false
  const baseTaxType = isSale
    ? (unlinkedSale
        ? (input.orderUniform?.singleSafeTaxType ?? null)
        : (input.lineTaxRate?.accountingTaxType ?? input.orderDefaultTaxType))
    : input.orderDefaultTaxType
  // The order's single safe identity is ALREADY post-swap, so it must not be swapped a second time.
  const accountingTaxType = (unlinkedSale
    ? baseTaxType
    : resolveSalesLineTaxType({
        baseTaxType,
        reverseCharge,
        reverseChargeSalesTaxType: input.reverseChargeSalesTaxType,
      }) ?? null) ?? null

  if (!accountingTaxType) {
    return {
      ok: false,
      reason: isSale
        ? (unlinkedSale
            ? `${input.label} carries no VAT rate of its own, so its credit note posts under the order's ` +
              'single VAT identity — and this order is not taxed uniformly, so there is no single ' +
              'identity to post it under. Set this line\'s tax rate on the order (or allocate the refund ' +
              'to the lines that do carry one), then record this refund.'
            : `${input.label} has no accounting tax code — neither its own VAT rate nor the order's default ` +
              'rate is mapped to one, so the credit note has no identity to post it under. Map the tax rate ' +
              'to an accounting tax code in Settings → Tax Rates, then record this refund.')
        : `Shipping posts under the order's default VAT identity, and this order's default rate ` +
          '(taxRateName) is missing, renamed or deactivated, so there is no identity to post it under. ' +
          'Restore/map that tax rate in Settings → Tax Rates, then record this refund.',
    }
  }

  // What this part of the order was actually CHARGED — read from the ORDER, never from the tax table.
  const charged: ChargedRate = isSale
    ? chargedRateFromSnapshot(input.chargedLine)
    // SalesOrder.taxRatePercent is the order's own column; null means the order recorded no VAT rate,
    // which is a fact about the order and not a missing reading.
    : { ok: true, rate: toDecimal(input.orderChargedRate ?? 0), tolerance: RATE_EPSILON }
  if (!charged.ok) {
    return {
      ok: false,
      reason:
        `${input.label} does not record what VAT was charged on it — ${charged.detail} — so IMS cannot ` +
        'check that its credit note would post at the rate the customer actually paid, and will not ' +
        'guess from the current tax table. Allocate this refund to the parts of the order that carry ' +
        'the money it came off, then record it.',
    }
  }

  const knownRates = input.rateByTaxType.get(accountingTaxType)
  if (!knownRates || knownRates.size === 0) {
    // Codex r4 #3: including — especially — the reverse-charge code. That the code is unmapped is not
    // evidence that it carries no VAT; it is evidence that IMS cannot price it.
    const isReverseChargeCode = reverseCharge &&
      Boolean(input.reverseChargeSalesTaxType) &&
      accountingTaxType === input.reverseChargeSalesTaxType
    return {
      ok: false,
      reason: isReverseChargeCode
        ? `${input.label} is reverse-charged, so its credit note posts under the reverse-charge sales ` +
          `tax code (${accountingTaxType}) — and no IMS tax rate is mapped to that code, so IMS cannot ` +
          'say what the credit note would be grossed up by. An unmapped code is not a 0% one. Map a 0% ' +
          'tax rate to that code in Settings → Tax Rates, then record this refund.'
        : `${input.label} posts under accounting tax code ${accountingTaxType}, which no IMS tax rate is ` +
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
  if (postedRate.sub(charged.rate).abs().gt(charged.tolerance)) {
    const reverseChargeSwapMissing = reverseCharge && !input.reverseChargeSalesTaxType
    return {
      ok: false,
      reason:
        `${input.label} was charged at ${charged.rate.mul(100).toDecimalPlaces(4).toString()}% but its ` +
        `credit note would post under accounting tax code ${accountingTaxType}, which is ` +
        `${postedRate.mul(100).toString()}%` +
        (reverseChargeSwapMissing
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
