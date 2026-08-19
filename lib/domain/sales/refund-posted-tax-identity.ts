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
 *   - shipping: `SalesOrder.shippingForeign` (the NET shipping charge) and the VAT that is NOT on any
 *     line — see the r5 note below.
 *
 * Where a part of the order carries no such snapshot (no stored net, or a net of zero, or figures too
 * small to pin a rate down inside the gap between two real VAT rates), the answer is NOT to substitute
 * the live rate. It is to say so and refuse, naming what the operator can do instead.
 *
 * Codex r4 #3: an UNMAPPED accounting tax code is not evidence of anything either. The r3 code returned
 * a 0% rate for a reverse-charge code that no IMS tax rate is mapped to, on the reasoning that reverse
 * charge carries no seller VAT — but IMS does not store that, and `resolveSalesLineTaxType` only swaps
 * the CODE, it knows nothing about the code's rate. Assuming zero converts the operator's gross as if no
 * VAT were charged. Every identity, reverse-charge included, is now priced from the tax table or
 * refused.
 *
 * ---------------------------------------------------------------------------------------------------
 * Codex r5 #1: `SalesOrder.taxRatePercent` IS THE ORDER'S HEADER DEFAULT, NOT WHAT SHIPPING WAS CHARGED.
 *
 * r4 fixed the LINE path to read the charged rate off the line's own money and left shipping reading
 * `taxRatePercent`, on the reasoning that it is an order column written alongside the money and so is
 * already historical. It is historical — and it is still the wrong figure. It is the order's HEADER
 * rate: what `createSalesOrder` charged shipping/fees/order-discount at, and what the WooCommerce
 * importer resolved as the order's overall rate. On an order whose shipping was taxed differently from
 * its goods — zero-rated delivery on standard-rated goods, or standard-rated delivery on zero-rated
 * goods, the very shape the shipping work exists for — it is not shipping's rate, and comparing the
 * posting rate against it either waves through a credit note that restates VAT shipping never bore, or
 * refuses one that is perfectly correct.
 *
 * IMS STORES NO SHIPPING-VAT COLUMN. `SalesOrder` carries `shippingForeign` / `shippingBase` (the NET
 * charge) and `taxForeign` / `taxBase` (the order's TOTAL VAT); `SalesOrderLine.taxForeign` carries each
 * line's. Shipping's own VAT exists only as the difference, and only in the ORDER's currency, where the
 * figures sum exactly:
 *
 *     shipping VAT = SalesOrder.taxForeign − Σ SalesOrderLine.taxForeign
 *
 * That identity is how both writers build the total. The WooCommerce importer sums the SAME stored line
 * figures it writes and adds `shipping_lines[].total_tax` (computeWcOrderForeignTotals), so the residue
 * is exactly WooCommerce's shipping tax with no accumulated rounding — fee lines are imported AS lines,
 * so their VAT is inside the Σ. createSalesOrder does the same, with one exception: it also SUBTRACTS
 * the VAT on an order-level discount. Where that discount exists the residue is `shipping VAT − discount
 * VAT`, two figures IMS cannot separate, so the derivation refuses rather than reporting the mixture as
 * shipping's rate.
 *
 * Codex r6 #3: WHICH writer built the total is knowable, so that refusal is scoped to the writer it
 * belongs to. r5 refused on any non-zero `SalesOrder.discountAmount` on the grounds that nothing on the
 * row says who wrote the totals — but something does: a WooCommerce-imported order is created WITH its
 * `ShoppingOrderLink`, in the same write, and the codebase already reads `shoppingLinks: { none: {} }`
 * as "a manual order" elsewhere. On a WC order the discount leg is a coupon RESIDUAL (Woo allocates
 * coupon money into the line totals, o3d-y14) that `computeWcOrderForeignTotals` never subtracts any
 * VAT for, so the residue is shipping's VAT and refusing it was a false refusal — on exactly the orders
 * this path exists to service. The caller passes `orderTaxIsSumOfComponents`; absent, the conservative
 * createSalesOrder reading still applies. (Base currency is not usable at all: taxBase is one conversion of the aggregate and
 * each line's taxBase is converted independently, so the residue there carries FX rounding that is not
 * shipping VAT — the same trap Codex r3 #3 found in refund-sync.)
 *
 * Codex r5 #2: THE TOLERANCE BELONGS TO WHERE THE MONEY WAS ROUNDED, NOT TO WHERE IT IS STORED.
 *
 * A rate derived from two rounded figures inherits their rounding, and r4 sized that rounding to the
 * `Decimal(18,4)` STORAGE scale — half a hundredth of a penny. Most of these figures were not rounded
 * there. WooCommerce rounds every line's and every shipping line's tax to the currency's minor unit
 * before IMS ever sees it, so a real £4.99 line at 20% arrives as £1.00 of VAT (not £0.998) and derives
 * 20.04% — 4.0e-4 out, twenty times the storage bound, and refused as "not the rate it was charged at"
 * when nothing whatever is wrong with it. Sizing the bound to the storage scale therefore refuses
 * ordinary imported orders, which is a refusal with no remedy: there is nothing for the operator to fix.
 *
 * So each figure is given the rounding it can actually carry, read off the figure itself: one that
 * carries sub-penny digits cannot have been rounded to the penny (0.0583 of VAT was computed at 4dp and
 * is worth ±0.00005), and one that does not may have been (£1.00 of VAT is worth ±0.005).
 *
 * Codex r6 #2: "the penny" is not a universal floor. r5 hard-coded 2 decimals as the coarsest a source
 * could have quantised to and noted that a 0-decimal currency (JPY, KRW, ISK) would then get a bound
 * that is too TIGHT — fail-closed, but wrong: ¥1,000 of VAT on ¥5,000 is a perfectly ordinary 20% line
 * whose figures were quantised to the YEN, worth ±0.5 each, and pricing it against a ±0.005 bound
 * refuses it with nothing whatever for an operator to fix. The coarsest quantisation is the CURRENCY's
 * minor unit (`currencyMinorUnits`), so the snapshot carries the currency its figures are in and the
 * bound follows from that — still clamped at the storage scale, since a 4-decimal currency (CLF) is
 * stored at 4dp anyway.
 *
 * ---------------------------------------------------------------------------------------------------
 * Codex r6 #1: THIS CHECK IS FOR EVERY ROUTE A SHIPPING AMOUNT TAKES, NOT ONLY THE HAND-RECORDED ONE.
 *
 * r5 guarded the exception inbox's Record-manually path and left the WooCommerce refund sync's ITEMISED
 * route — `wcRefund.shipping_lines`, which is what a storefront shipping refund actually arrives as —
 * pushing an unlinked `lineKind: 'shipping'` line straight into `createRefund` with nothing checking
 * what it would be re-grossed at. The amount is already NET there, so no gross→net conversion draws
 * attention to the rate; the divergence lands entirely on the credit note's TOTAL. Zero-rated postage
 * on a 20%-default order credits £12 against a £10 refund and the sync reports success.
 *
 * That route does not have to derive shipping's VAT, because WooCommerce states it: each refunded
 * shipping line carries its own `total` and `total_tax`. `shippingTaxForeign` is how a caller supplies
 * a VAT figure it did not have to derive, and the rest of the check — resolve the identity the way the
 * posting resolves it, price it from the tax table, compare — is shared verbatim.
 * ---------------------------------------------------------------------------------------------------
 *
 * Every refusal names a remedy an operator (or an admin) can carry out — mapping the tax rate to an
 * accounting tax code, mapping a 0% rate to the reverse-charge code, configuring the reverse-charge
 * code, reactivating the order's default rate, or allocating the money to the part of the order it
 * actually came off — after which the same row can be recorded.
 */

import { resolveSalesLineTaxType } from '@/lib/accounting/reverse-charge'
import { currencyMinorUnits, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * TaxRate.rate is Decimal(5,4), so two STORED rates that differ by less than half of the last stored
 * digit are the same rate. Exported because the posting side re-prices the identity under the order
 * lock and has to use the same notion of "the same rate" (Codex r4 #2). It is the floor for a DERIVED
 * rate's tolerance too — no comparison of rates can be finer than the scale they are stored at.
 */
export const RATE_EPSILON = 0.00005

/** Decimal(18,4) — the storage scale of every money figure in this module. */
const STORAGE_DECIMALS = 4

/**
 * The COARSEST quantisation a source of these figures could have used: the currency's own minor unit,
 * which is what WooCommerce rounds every line and shipping tax to before IMS stores it (Codex r5 #2)
 * and what createSalesOrder's own inputs are entered in. Clamped at the storage scale, because a
 * currency with more minor-unit digits than Decimal(18,4) holds (CLF, UYW) is stored at 4dp regardless.
 *
 * Codex r6 #2: read from the currency rather than assumed to be the penny. A zero-decimal currency
 * quantises to the whole unit and a 3-decimal one to the thousandth; hard-coding 2 gives the first a
 * bound a hundred times too tight (a refusal an operator cannot act on) and the second one four times
 * too loose.
 */
function sourceDecimalsFor(currency: string): number {
  return Math.min(currencyMinorUnits(currency), STORAGE_DECIMALS)
}

/**
 * Half of the last digit this figure can actually carry — its rounding exposure.
 *
 * Read off the figure itself rather than assumed, because the two sources quantise differently and the
 * row does not say which wrote it. A figure with sub-minor-unit digits (0.0583 in GBP) was computed at
 * the storage scale and is worth ±0.00005; one without (1.00, 0.6, 3) may have been rounded to the
 * minor unit and is worth ±0.005 in GBP, ±0.5 in JPY. Decimal drops trailing zeros — 0.6000 reads as 1
 * decimal place — so the count is clamped at both ends: never finer than the storage scale, never
 * coarser than the currency's minor unit.
 */
function moneyHalfUnit(amount: Decimal, sourceDecimals: number): Decimal {
  const decimals = Math.min(Math.max(amount.decimalPlaces(), sourceDecimals), STORAGE_DECIMALS)
  return toDecimal(5).div(toDecimal(10).pow(decimals + 1))
}

/**
 * The smallest gap between two DISTINCT rates a credit note could really be posted under: half a
 * percentage point (5% against 5.5%, 9% against 9.5%, 13% against 13.5% are all live EU VAT rates).
 */
const MIN_DISTINCT_RATE_GAP = 0.005

/**
 * A rate DERIVED from two rounded money figures carries their rounding, and on a small amount that
 * uncertainty grows without bound (a 1p line pins its rate down to nothing at all). It must stay under
 * HALF of MIN_DISTINCT_RATE_GAP: a derived rate uncertain by more than half the gap can sit at the
 * midpoint and agree with both rates, and the comparison could no longer do the one thing it exists for.
 * 0.2 of a percentage point against a 0.25 limit, so the rejection is strict rather than marginal —
 * past it the amount is treated as carrying no usable snapshot rather than waved through on a tolerance
 * wide enough to hide the defect.
 *
 * Note what this bound is in MONEY: tolerance x net is (halfUnit of the VAT + rate x halfUnit of the
 * net), i.e. at most about 0.006 whatever the amount. An accepted rate always reproduces the VAT the
 * order records to within half a penny of it; the cap only ever makes that stricter.
 */
const MAX_DERIVED_RATE_TOLERANCE = MIN_DISTINCT_RATE_GAP * 0.4 // 0.002 — 0.2pp against a 0.25pp limit

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
  /**
   * The currency both figures are in — SalesOrder.currency. Required (Codex r6 #2): it is what says how
   * coarsely they may have been quantised, and therefore how much rounding a rate derived from them
   * inherits. Defaulting it to the penny is what refused ordinary zero-decimal-currency lines.
   */
  currency: string
  netForeign?: DecimalInput
  taxForeign?: DecimalInput
}

/**
 * The order's own record of what SHIPPING was charged, in the order's currency (Codex r5 #1). IMS has
 * no shipping-VAT column, so the VAT half is the money that is on the order but on none of its lines:
 *
 *     SalesOrder.taxForeign − Σ SalesOrderLine.taxForeign
 *
 * which is exactly how both writers built `taxForeign` in the first place. Every line of the order must
 * be supplied — a partial read makes the residue larger than shipping's VAT, not smaller — and
 * `orderDiscountAmount` must be supplied because createSalesOrder nets an order-level discount's VAT off
 * the same total, which puts a second, inseparable figure into the residue.
 *
 * `undefined` anywhere means the caller did not read it, which is never the same as zero.
 */
export type ChargedShippingSnapshot = {
  /** The currency every figure below is in — SalesOrder.currency. See ChargedLineSnapshot.currency. */
  currency: string
  /**
   * The NET shipping amount whose rate is being read — SalesOrder.shippingForeign for a target on the
   * ORDER (both writers store it net of VAT), or the net shipping amount of the storefront refund being
   * checked, when the caller is pricing that instead (see shippingTaxForeign).
   */
  netForeign?: DecimalInput
  /**
   * Codex r6 #1: shipping's VAT stated DIRECTLY, when the caller has a source that carries one. IMS's
   * own SalesOrder does not — which is the whole reason for the residue below — but a WooCommerce
   * refund payload states the VAT it returned on each shipping line (`shipping_lines[].total_tax`), and
   * on an ITEMISED refund that figure, against that line's own net, is exactly what the credit note has
   * to restate. Supplied together with `netForeign` it replaces the residue entirely: the discount,
   * every-line-read and negative-residue refusals below do not apply to a figure nobody had to derive.
   */
  shippingTaxForeign?: DecimalInput
  /** SalesOrder.taxForeign — the order's TOTAL VAT, in its own currency. */
  orderTaxForeign?: DecimalInput
  /** SalesOrderLine.taxForeign for EVERY line on the order, including imported fee lines. */
  lineTaxForeign?: readonly DecimalInput[]
  /** SalesOrder.discountAmount — an order-level discount whose VAT may be netted off orderTaxForeign. */
  orderDiscountAmount?: DecimalInput
  /**
   * Codex r6 #3: TRUE when `orderTaxForeign` is the plain SUM of every component's VAT — each line's
   * plus each shipping line's — with nothing netted off it. That is what the WooCommerce importer
   * builds (`computeWcOrderForeignTotals`), and it makes the residue shipping's VAT whatever
   * `orderDiscountAmount` says: Woo allocates coupon money INTO the lines, so a WC order's order-level
   * discount is a residual that no VAT was ever subtracted for.
   *
   * Absent or false is the conservative reading — `createSalesOrder` DOES subtract an order-level
   * discount's VAT from the same total — so an unknown writer with a non-zero discount still refuses.
   * The caller establishes it from the order's own provenance (a WooCommerce ShoppingOrderLink), never
   * from the size of a number.
   */
  orderTaxIsSumOfComponents?: boolean
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
 * The rate an amount was CHARGED at, from the money the order recorded for it. Never from the tax table.
 *
 * The derived rate inherits the rounding of BOTH figures, each sized to where it was actually rounded
 * (Codex r5 #2): `rate = tax / net` carries at most (halfUnit(tax) + rate x halfUnit(net)) / net of
 * error. That is the tolerance the comparison is entitled to — no wider (which would hide a real rate
 * difference) and no narrower (which would refuse a legitimate amount for rounding it did not choose).
 */
function chargedRateFromMoney(net: Decimal, tax: Decimal, netNoun: string, currency: string): ChargedRate {
  if (net.lte(0)) {
    return { ok: false, detail: `it carries no ${netNoun} (${net.toFixed(4)}), so no rate can be read off it` }
  }
  const sourceDecimals = sourceDecimalsFor(currency)
  const rate = tax.div(net)
  // Evaluated with the derived rate itself rather than the true one — accurate enough for a bound.
  const tolerance = moneyHalfUnit(tax, sourceDecimals)
    .add(rate.abs().mul(moneyHalfUnit(net, sourceDecimals)))
    .div(net)
    .toNumber()
  if (tolerance > MAX_DERIVED_RATE_TOLERANCE) {
    return {
      ok: false,
      detail:
        `its stored amounts (${tax.toFixed(4)} of VAT on a ${netNoun} of ${net.toFixed(4)}) are too small ` +
        'to fix the rate it was charged at to inside the gap between two real VAT rates',
    }
  }
  return { ok: true, rate, tolerance: Math.max(RATE_EPSILON, tolerance) }
}

/** The rate a sale LINE was charged at, from its own money snapshot. */
function chargedRateFromSnapshot(snapshot: ChargedLineSnapshot | null | undefined): ChargedRate {
  if (snapshot?.netForeign == null || snapshot.taxForeign == null) {
    return { ok: false, detail: 'IMS holds no record of the net it was sold at and the VAT taken on it' }
  }
  return chargedRateFromMoney(
    toDecimal(snapshot.netForeign),
    toDecimal(snapshot.taxForeign),
    'net amount',
    snapshot.currency,
  )
}

/**
 * The rate SHIPPING was charged at (Codex r5 #1) — from the order's own money, not from its header
 * default rate. See ChargedShippingSnapshot for why the VAT half is a residue and what makes it unusable.
 */
function chargedShippingRateFromSnapshot(snapshot: ChargedShippingSnapshot | null | undefined): ChargedRate {
  const money = chargedShippingMoney(snapshot)
  if (!money.ok) return money
  return chargedRateFromMoney(money.netForeign, money.taxForeign, 'shipping charge', money.currency)
}

/**
 * o3d-w00 (Codex r7): the shipping leg's NET and its VAT, before either is turned into a rate.
 *
 * Split out of the rate derivation because the writer's fence compares in money (see
 * `postedCreditNoteTotalCheck`) and needs the same two figures — and, more importantly, the same
 * REFUSALS: an order-level discount whose VAT is netted off the same total, a partial read of the
 * order's lines, or a negative remainder all mean the residue is not shipping's VAT and must not be
 * used as if it were, whatever is then done with it.
 */
export function chargedShippingMoney(snapshot: ChargedShippingSnapshot | null | undefined):
  | { ok: true; currency: string; netForeign: Decimal; taxForeign: Decimal }
  | { ok: false; detail: string } {
  // Codex r6 #1: a caller that HAS shipping's VAT does not derive it. The residue exists only because
  // SalesOrder stores no shipping-VAT column; a WooCommerce refund's own shipping line states one.
  if (snapshot?.netForeign != null && snapshot.shippingTaxForeign != null) {
    return {
      ok: true,
      currency: snapshot.currency,
      netForeign: toDecimal(snapshot.netForeign),
      taxForeign: toDecimal(snapshot.shippingTaxForeign),
    }
  }
  if (snapshot?.netForeign == null || snapshot.orderTaxForeign == null || snapshot.lineTaxForeign == null) {
    return {
      ok: false,
      detail:
        'IMS stores no VAT figure of its own for a shipping charge, and the order totals its VAT would ' +
        'be derived from were not read',
    }
  }
  if (snapshot.lineTaxForeign.some((lineTax) => lineTax == null)) {
    return {
      ok: false,
      detail:
        "not every order line's VAT was read, and shipping's VAT is what the order records over and " +
        'above its lines',
    }
  }
  const orderDiscount = toDecimal(snapshot.orderDiscountAmount ?? 0)
  // Codex r6 #3: only for a writer that MIGHT have netted the discount's VAT off the same total.
  // createSalesOrder does; the WooCommerce importer does not (it sums the components and allocates
  // coupon money into the lines), so on a WC order the residue is shipping's VAT discount or no
  // discount, and refusing there was a false refusal on the commonest kind of order there is.
  if (!orderDiscount.isZero() && !snapshot.orderTaxIsSumOfComponents) {
    return {
      ok: false,
      detail:
        `this order carries an order-level discount (${orderDiscount.toFixed(4)}) whose VAT is netted off ` +
        "the same total, so what the order records over and above its lines is shipping's VAT and the " +
        "discount's together and neither can be read out of it",
    }
  }
  const lineTax = snapshot.lineTaxForeign.reduce<Decimal>((sum, tax) => sum.add(toDecimal(tax)), toDecimal(0))
  const orderTax = toDecimal(snapshot.orderTaxForeign)
  const shippingTax = orderTax.sub(lineTax)
  if (shippingTax.isNegative()) {
    return {
      ok: false,
      detail:
        `the order records less VAT (${orderTax.toFixed(4)}) than its own lines carry ` +
        `(${lineTax.toFixed(4)}), so no shipping VAT can be read out of the difference`,
    }
  }
  return { ok: true, currency: snapshot.currency, netForeign: toDecimal(snapshot.netForeign), taxForeign: shippingTax }
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
 * The same, for a refused SHIPPING target: what the order says shipping was charged, never the order's
 * header default rate — which is a different figure whenever shipping was taxed differently from the
 * goods, and is exactly the substitution Codex r5 #1 found (o3d-w00). Null when it cannot be derived.
 */
export function chargedRateFromShippingSnapshot(snapshot: ChargedShippingSnapshot | null | undefined): Decimal | null {
  const charged = chargedShippingRateFromSnapshot(snapshot)
  return charged.ok ? charged.rate : null
}

/**
 * Everything needed to say which accounting tax identity a refund allocation against this target will
 * post under, what that identity is worth, and what the ORDER says this part of it was charged.
 */
export type PostedRefundTaxIdentityInput = {
  kind: 'sale' | 'shipping'
  /** The TaxRate ROW linked to the order line, for a `sale` target. Null when the line has none. */
  lineTaxRate?: PostedRefundTaxRate | null
  /** The order line's own money snapshot, for a `sale` target. Ignored for `shipping`. */
  chargedLine?: ChargedLineSnapshot | null
  /** accountingTaxType of the ACTIVE TaxRate named SalesOrder.taxRateName, or null. */
  orderDefaultTaxType: string | null
  /**
   * The order's money snapshot of its SHIPPING leg, for a `shipping` target. Ignored for `sale`.
   *
   * Codex r5 #1: deliberately NOT `SalesOrder.taxRatePercent`. That column is the order's HEADER
   * default rate, which is only shipping's rate on an order taxed uniformly — and this type not being
   * able to express it is how that substitution is kept from coming back.
   */
  chargedShipping?: ChargedShippingSnapshot | null
  /** The order's single safe identity, for a sale line that has no TaxRate row of its own. */
  orderUniform?: { singleSafeTaxType: string | null; uniformlyReverseCharged: boolean }
  /** settings.reverseChargeSalesTaxType ('' disables the swap). */
  reverseChargeSalesTaxType?: string | null
  rateByTaxType: TaxTypeRateIndex
  /** For the refusal messages: what this target is called on screen. */
  label: string
}

/**
 * o3d-w00 (Codex r7 #5): the identity and its PRICE, with no comparison against what the target was
 * charged — steps 1 and 3 of `resolvePostedRefundTaxIdentity` without step 2.
 *
 * Split out because the two consumers ask genuinely different questions of the same identity:
 *
 *   - the hand-recording path has to DIVIDE an operator's gross by this rate, so an amount whose own
 *     figures cannot pin a rate down to inside the gap between two real VAT rates is unusable to it,
 *     and refusing is the only safe answer (`resolvePostedRefundTaxIdentity`);
 *   - the WRITER's fence already holds a NET amount. Nothing is divided; only the credit note's TOTAL
 *     can come out wrong. Asking it to pin the rate down would refuse every refund of a line under
 *     about £3 — where two figures each rounded to the penny leave the rate uncertain by more than
 *     0.2pp — and the remedy that refusal names (record it by hand against the same line) refuses for
 *     the identical reason. A refusal with no performable remedy is a defect in its own right (r5 #2),
 *     so the writer prices the identity here and then compares in MONEY, via
 *     `postedCreditNoteTotalCheck`, which needs no rate to be pinned down at all.
 *
 * Both still refuse an identity that cannot be established or priced — an unmapped code is not a 0%
 * one, whichever question is being asked of it.
 */
export function priceRefundTaxIdentity(input: PostedRefundTaxIdentityInput): PostedRefundTaxIdentity {
  const code = resolveIdentityCode(input)
  if (!code.ok) return code
  const priced = priceIdentityCode(code, input)
  if (!priced.ok) return priced
  return {
    ok: true,
    accountingTaxType: code.accountingTaxType,
    reverseCharge: code.reverseCharge,
    vatRate: priced.rate,
  }
}

/**
 * o3d-w00 (Codex r7): does the credit note COME TO what the refund settles?
 *
 * The rate comparison above asks whether two rates are the same number. This asks the question the
 * money actually poses: the ledger will re-gross this NET amount at `postedRate`, so it will produce
 * `net x (1 + postedRate)` — and what the customer's money says the same amount is worth, gross, is
 * `net + tax`. If those agree to within the currency's minor unit, the credit note settles the refund
 * whatever either figure implies about a rate; if they do not, it does not, and by exactly the
 * difference reported here.
 *
 * Why this and not the rate comparison, at the writer: a £2.00 line bearing £0.40 of VAT is an
 * entirely ordinary 20% line, but two figures rounded to the penny leave its DERIVED rate uncertain by
 * (0.005 + 0.2 x 0.005) / 2 = 0.3pp — past the cap a divided gross needs — so the rate comparison
 * treats it as carrying no usable snapshot. In money there is no uncertainty worth the name: 2.00 +
 * 0.40 against 2.00 x 1.2 is 2.40 against 2.40. The same line zero-rated against a 20% code is 2.00
 * against 2.40, which is the divergence the fence exists for, and it is caught at any size.
 *
 * The tolerance is ONE minor unit: the charged VAT reached IMS rounded to it (± half), and the ledger
 * rounds its own computed VAT to it (± half). `{ ok: true }` with no snapshot supplied means there is
 * nothing to check the posting against — never that it agrees.
 */
export function postedCreditNoteTotalCheck(input: {
  /** The currency both figures are in, which fixes the minor unit the tolerance is measured in. */
  currency: string
  /** The NET amount whose posting is being checked, and the VAT the order/refund records on THAT net. */
  netForeign?: DecimalInput | null
  taxForeign?: DecimalInput | null
  /** The rate the identity this money posts under is worth, from `priceRefundTaxIdentity`. */
  postedRate: Decimal
  /** Which target this is, so the refusal names the remedy that actually applies to it. */
  kind: 'sale' | 'shipping'
  /** For the refusal message: what this target is called on screen. */
  label: string
  /**
   * o3d-w00 (Codex r8 #5): check a leg whose NET is zero or NEGATIVE as well.
   *
   * A single refund line's net is never negative, and one of zero credits nothing, so the default is to
   * pass both unchecked. A chargeback's shipping and order-discount legs COMBINED are a different
   * figure: the discount leg is negative by construction (it mirrors the invoice's negative discount
   * line) and IMS records only their combined VAT, so the pair has to be checked as one amount whose
   * sign is whichever of the two legs is larger. The arithmetic is sign-agnostic — net x (1 + rate)
   * against net + tax — so only this guard has to be lifted.
   */
  allowNonPositiveNet?: boolean
}): { ok: true } | { ok: false; reason: string } {
  if (input.netForeign == null || input.taxForeign == null) return { ok: true }
  const net = toDecimal(input.netForeign)
  const tax = toDecimal(input.taxForeign)
  if (!net.isFinite() || !tax.isFinite()) return { ok: true }
  if (net.lte(0) && !input.allowNonPositiveNet) return { ok: true }
  if (net.isZero() && tax.isZero()) return { ok: true }
  const chargedGross = net.add(tax)
  const postedGross = net.mul(toDecimal(1).add(input.postedRate))
  const tolerance = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(input.currency)))
  if (postedGross.sub(chargedGross).abs().lte(tolerance)) return { ok: true }
  return {
    ok: false,
    reason:
      `${input.label} returned ${chargedGross.toDecimalPlaces(2).toFixed(2)} of the customer's money ` +
      `(${net.toDecimalPlaces(2).toFixed(2)} plus ${tax.toDecimalPlaces(2).toFixed(2)} of VAT), but its ` +
      `credit note would come to ${postedGross.toDecimalPlaces(2).toFixed(2)} — the accounting tax code ` +
      `it posts under is worth ${input.postedRate.mul(100).toString()}%, which is not the VAT this money ` +
      'bore. ' +
      (input.kind === 'sale'
        ? "Map this line's tax rate to an accounting tax code carrying the rate it was sold at " +
          '(Settings → Tax Rates), then record this refund.'
        : "Shipping posts under the ORDER's default VAT identity, which is not the rate this order " +
          'charged shipping at: give that rate an accounting tax code carrying the rate shipping was ' +
          'actually charged (Settings → Tax Rates), or allocate this refund to the order lines it came ' +
          'off, then record it.'),
  }
}

/**
 * o3d-w00 (Codex r8 #1): one leg of a refund, as the AGGREGATE check sees it.
 *
 * `postedNetForeign` is what this refund actually posts; `chargedNetForeign`/`chargedTaxForeign` are
 * the money the rate is READ OFF, which is not the same basis — a refund of one unit of a two-unit
 * line is priced against the whole line's snapshot, because that is the only record of what the unit
 * was charged at. The two are related by the ratio between them, which is why both are carried.
 */
export type PostedCreditNoteLeg = {
  label: string
  postedNetForeign: DecimalInput
  chargedNetForeign: DecimalInput
  chargedTaxForeign: DecimalInput
  /** What the accounting tax code this leg posts under is worth, from `priceRefundTaxIdentity`. */
  postedRate: Decimal
}

/**
 * o3d-w00 (Codex r8 #1): does the WHOLE credit note come to what the WHOLE refund settles?
 *
 * `postedCreditNoteTotalCheck` is applied to one leg at a time with a tolerance of one minor unit,
 * which is the right bound for one leg and the wrong bound for a refund made of many. A GBP 1.00 line
 * charged at 19% but posting under a 20% code is out by exactly GBP 0.01 — inside the per-leg
 * tolerance, every time — so a hundred such lines pass one by one while the credit note they add up to
 * exceeds the storefront refund by a pound. The per-leg check cannot see that; nothing did.
 *
 * WHAT IS MEASURED. Not the credit note's arithmetic total (the ledger quantises its own computed VAT
 * per line, and that residue is neither a rate disagreement nor anything an operator could fix by
 * remapping a tax code). What is measured is the RATE divergence, expressed in money on each leg's own
 * basis and summed:
 *
 *     drift = SUM over legs of  postedNet x (postedRate - chargedRate)
 *
 * WHAT IS ALLOWED. Each charged pair reached IMS quantised — by WooCommerce to the currency's minor
 * unit, by createSalesOrder to whatever its inputs carried — so the rate read off it is uncertain by
 * (halfUnit(tax) + rate x halfUnit(net)) / net, exactly the bound `chargedRateFromMoney` derives. In
 * money on the posted net that is `postedNet / chargedNet` times (halfUnit(tax) + rate x halfUnit(net)),
 * and it is allowed once per leg — the honest sum of the same rounding the per-leg check allows, rather
 * than a flat minor unit per leg that a wrong rate can hide inside indefinitely. One further minor unit
 * of slack covers the credit note's own total.
 *
 * The result: a leg whose figures merely round awkwardly contributes at most its own rounding and never
 * accumulates past the slack, while a systematic rate error contributes a fixed fraction of every leg
 * and crosses the bound by the third one.
 */
export function postedCreditNoteAggregateCheck(input: {
  /** The currency every figure is in, which fixes the minor unit the slack is measured in. */
  currency: string
  legs: readonly PostedCreditNoteLeg[]
}): { ok: true } | { ok: false; reason: string } {
  const sourceDecimals = sourceDecimalsFor(input.currency)
  const minorUnit = toDecimal(1).div(toDecimal(10).pow(currencyMinorUnits(input.currency)))
  let drift = toDecimal(0)
  let allowance = minorUnit
  let chargedGross = toDecimal(0)
  let postedGross = toDecimal(0)
  let checked = 0
  for (const leg of input.legs) {
    const postedNet = toDecimal(leg.postedNetForeign)
    const chargedNet = toDecimal(leg.chargedNetForeign)
    const chargedTax = toDecimal(leg.chargedTaxForeign)
    if (!postedNet.isFinite() || !chargedNet.isFinite() || !chargedTax.isFinite()) continue
    // A leg with no net on either side prices nothing and is left to the per-leg check, which passes
    // it for the same reason: nothing is credited, so no credit-note total can be wrong about it.
    if (postedNet.lte(0) || chargedNet.lte(0)) continue
    checked += 1
    const chargedRate = chargedTax.div(chargedNet)
    const scale = postedNet.div(chargedNet)
    drift = drift.add(postedNet.mul(leg.postedRate.sub(chargedRate)))
    allowance = allowance.add(scale.mul(
      moneyHalfUnit(chargedTax, sourceDecimals).add(chargedRate.abs().mul(moneyHalfUnit(chargedNet, sourceDecimals))),
    ))
    chargedGross = chargedGross.add(postedNet.mul(toDecimal(1).add(chargedRate)))
    postedGross = postedGross.add(postedNet.mul(toDecimal(1).add(leg.postedRate)))
  }
  // One leg cannot drift past the per-leg check without failing it first, so the aggregate never
  // refuses alone there; it exists for the many-leg case the per-leg tolerance is blind to.
  if (checked < 2 || drift.abs().lte(allowance)) return { ok: true }
  return {
    ok: false,
    reason:
      `This refund returned ${chargedGross.toDecimalPlaces(2).toFixed(2)} of the customer's money across ` +
      `${checked} parts of the order, but the credit note raised for it would come to ` +
      `${postedGross.toDecimalPlaces(2).toFixed(2)} — ${drift.abs().toDecimalPlaces(2).toFixed(2)} ` +
      `${drift.isNegative() ? 'under' : 'over'}. No single part is out by enough to be refused on its ` +
      'own, but the accounting tax codes these parts post under are not worth the VAT they bore, and ' +
      'the difference adds up. Map each line\'s tax rate to an accounting tax code carrying the rate it ' +
      'was sold at (Settings → Tax Rates), then record this refund.',
  }
}

type ResolvedIdentityCode =
  | { ok: true; accountingTaxType: string; reverseCharge: boolean; unlinkedSale: boolean }
  | { ok: false; reason: string }

/** Step 1: WHICH accounting tax code this target posts under. Mirrors resolveRefundLineTaxIdentity. */
function resolveIdentityCode(input: PostedRefundTaxIdentityInput): ResolvedIdentityCode {
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
  return { ok: true, accountingTaxType, reverseCharge, unlinkedSale }
}

/** Step 3: WHAT that code is worth, from the SALES-usable tax rates mapped to it. */
function priceIdentityCode(
  code: Extract<ResolvedIdentityCode, { ok: true }>,
  input: PostedRefundTaxIdentityInput,
): { ok: true; rate: Decimal } | { ok: false; reason: string } {
  const { accountingTaxType, reverseCharge } = code
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
  return { ok: true, rate: toDecimal([...knownRates][0]) }
}

/**
 * o3d-w00 (Codex r8 #4): what an ALREADY-SNAPSHOTTED accounting tax code is worth, today.
 *
 * `priceRefundTaxIdentity` resolves the code from the order and then prices it. A refund that already
 * exists has its code stored on every line (`SalesOrderRefundLine.accountingTaxType`), so an accounting
 * RETRY has nothing to resolve — but it still has everything to re-price, because the tax table is
 * mutable and the credit note has not been posted yet. Same refusals: an unmapped code is not a 0% one,
 * and a code IMS maps two ways is not one IMS may pick from.
 */
export function priceSnapshottedTaxIdentity(input: {
  accountingTaxType: string
  rateByTaxType: TaxTypeRateIndex
  label: string
}): { ok: true; rate: Decimal } | { ok: false; reason: string } {
  return priceIdentityCode(
    { ok: true, accountingTaxType: input.accountingTaxType, reverseCharge: false, unlinkedSale: false },
    {
      kind: 'sale',
      orderDefaultTaxType: null,
      rateByTaxType: input.rateByTaxType,
      label: input.label,
    },
  )
}

/**
 * Resolve the tax identity — and therefore the rate — a refund allocation against this target will post
 * under. Mirrors `resolveRefundLineTaxIdentity` in refund-service exactly, prices the identity it lands
 * on from the TaxRate table, and checks that price against what the ORDER says this part of it was
 * charged.
 *
 * The three steps run in this order deliberately: an amount whose own money cannot say what it was
 * charged is reported as such BEFORE its code is priced, because that is the refusal whose remedy
 * ("allocate this refund to the parts of the order that carry the money it came off") the operator can
 * act on without touching the tax table at all.
 */
export function resolvePostedRefundTaxIdentity(input: PostedRefundTaxIdentityInput): PostedRefundTaxIdentity {
  const isSale = input.kind === 'sale'
  const code = resolveIdentityCode(input)
  if (!code.ok) return code

  // What this part of the order was actually CHARGED — read from the ORDER's own money, never from the
  // tax table and never from the order's header default rate (Codex r4 #1 / r5 #1).
  const charged: ChargedRate = isSale
    ? chargedRateFromSnapshot(input.chargedLine)
    : chargedShippingRateFromSnapshot(input.chargedShipping)
  if (!charged.ok) {
    return {
      ok: false,
      reason:
        `${input.label} does not record what VAT was charged on it — ${charged.detail} — so IMS cannot ` +
        'check that its credit note would post at the rate the customer actually paid, and will not ' +
        'guess from the current tax table or from the rate on the order header. ' +
        (isSale
          ? 'Allocate this refund to the parts of the order that carry the money it came off, then record it.'
          : 'Allocate this refund to the order lines it came off instead, then record it.'),
    }
  }

  const priced = priceIdentityCode(code, input)
  if (!priced.ok) return priced
  const { accountingTaxType, reverseCharge } = code
  const postedRate = priced.rate
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
          : isSale
            ? ' — so the credit note would restate VAT the customer was never charged. Map this line\'s ' +
              'tax rate to an accounting tax code that matches the rate it was sold at (Settings → Tax ' +
              'Rates), then record this refund.'
            : ' — so the credit note would restate VAT the customer was never charged. Shipping posts ' +
              'under the order\'s DEFAULT VAT identity, which is not the rate this order charged ' +
              'shipping at: give that rate an accounting tax code carrying the rate shipping was ' +
              'actually charged (Settings → Tax Rates), or allocate this refund to the order lines it ' +
              'came off, then record it.'),
    }
  }
  return { ok: true, accountingTaxType, reverseCharge, vatRate: postedRate }
}
