import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import {
  collapseUnplacedCreditDecimal,
  creditPlacement,
  type CollapsedUnplacedCreditDecimal,
} from '@/lib/domain/sales/refund-basis-analytics'

/**
 * THE CREDIT-BUCKET SUBSTRATE THE BASIS-AWARE REPORTS SHARE.
 *
 * Lifted out of `sales-fulfillment-analytics.ts` by o3d-rv4a WITHOUT a change of behaviour, because
 * the COGS report (`lib/domain/inventory/inventory-costing-reports.ts`) had to answer the identical
 * question and the alternative was a second copy of it. A second copy is the specific failure this
 * whole line of work keeps finding: two reports answering one question differently is its own
 * defect, and o3d-la3n's `combineNetLinearFigureBounds` was deleted for exactly that reason — the
 * operation that could not be both sound and tight was given no name to call.
 *
 * Everything below is the o3d-kyey text verbatim; the only additions are `scaleCredits`, which the
 * COGS report needs because its revenue is allocated across groups by quantity share, and the
 * exports.
 */

/**
 * o3d-kyey: WHAT A PERIOD'S CREDIT IS, SPLIT BY THE BASIS IT WAS RECORDED ON.
 *
 * Every one of these three reports subtracts credit from a revenue figure, and each figure is on a
 * basis of its own: Sales Analytics and Customer Mix build revenue from `SalesOrder.totalBase`,
 * which is VAT-INCLUSIVE, while Gross Margin builds it from `SalesOrderLine.totalBase`, which is
 * ex-VAT. Only the credit recorded on the SAME basis as the figure is the same unit as it, so only
 * that one is subtracted; the other two are carried beside the figure and make it a stated bound.
 * Nothing is converted between the bases — on a mixed-rate order the rate that produced a gross
 * credit is not recoverable from stored data, which is the conclusion `refund-basis-analytics`
 * reaches and `o3d-w00` made the refund CREATE path fail closed over.
 *
 * The two completeness flags are tracked SEPARATELY rather than derived from the sums, because a
 * +5 and a -5 of unplaceable credit sum to zero while neither was placeable.
 */
export type CreditBuckets = {
  /** Credit stamped NET (ex-VAT). */
  net: Prisma.Decimal
  /** Credit stamped GROSS (VAT-inclusive). */
  gross: Prisma.Decimal
  /** Credit whose basis was never proved. Never guessed at, never converted. */
  unknown: Prisma.Decimal
  /**
   * THE POSITIVE PART OF EACH BUCKET — `Σ max(entry, 0)` — carried beside the signed total because
   * the signed total cannot bound anything on its own.
   *
   * A credit that is not the figure's unit contributes an INTERVAL, not an amount: an entry `b` on
   * another basis is worth somewhere in `[min(b, 0), max(b, 0)]` once expressed in the figure's
   * unit. Adding the entries up first destroys that interval — +120 and −120 of GROSS credit sum to
   * a bucket of zero, and a bound read off that zero says the figure cannot move when the figure
   * can move by 120 in either direction. Recording the positive part AT THE ENTRY keeps both
   * endpoints recoverable from the two numbers: `Σ max(b, 0)` is this field and `Σ min(b, 0)` is
   * `total − this field`.
   *
   * Same reasoning as the two completeness flags below being tracked rather than derived from the
   * sums, applied to the AMOUNTS instead of the flags.
   */
  netPositive: Prisma.Decimal
  grossPositive: Prisma.Decimal
  unknownPositive: Prisma.Decimal
  /** True while every credit seen could be placed on a NET-basis figure. */
  netBasisComplete: boolean
  /** True while every credit seen could be placed on a GROSS-basis figure. */
  grossBasisComplete: boolean
}

export function emptyCredits(): CreditBuckets {
  return {
    net: new Prisma.Decimal(0),
    gross: new Prisma.Decimal(0),
    unknown: new Prisma.Decimal(0),
    netPositive: new Prisma.Decimal(0),
    grossPositive: new Prisma.Decimal(0),
    unknownPositive: new Prisma.Decimal(0),
    netBasisComplete: true,
    grossBasisComplete: true,
  }
}

export function addCredit(buckets: CreditBuckets, totalsBasis: string | null, amount: DecimalInput): void {
  const onNet = creditPlacement('NET', totalsBasis, amount)
  const onGross = creditPlacement('GROSS', totalsBasis, amount)
  const value = toDecimal(amount)
  // THIS IS THE LAST PLACE AN INDIVIDUAL CREDIT EXISTS. Every consumer above this line sees bucket
  // sums only, so a separation that is not made here can never be made at all — which is exactly
  // how two opposite same-basis credits used to reach the interval arithmetic as a single zero.
  const positive = value.gt(0) ? value : new Prisma.Decimal(0)
  if (onNet.bucket === 'net') {
    buckets.net = buckets.net.add(value)
    buckets.netPositive = buckets.netPositive.add(positive)
  } else if (onNet.bucket === 'gross') {
    buckets.gross = buckets.gross.add(value)
    buckets.grossPositive = buckets.grossPositive.add(positive)
  } else {
    buckets.unknown = buckets.unknown.add(value)
    buckets.unknownPositive = buckets.unknownPositive.add(positive)
  }
  if (!onNet.placeable) buckets.netBasisComplete = false
  if (!onGross.placeable) buckets.grossBasisComplete = false
}

export function mergeCredits(into: CreditBuckets, from: CreditBuckets): void {
  into.net = into.net.add(from.net)
  into.gross = into.gross.add(from.gross)
  into.unknown = into.unknown.add(from.unknown)
  into.netPositive = into.netPositive.add(from.netPositive)
  into.grossPositive = into.grossPositive.add(from.grossPositive)
  into.unknownPositive = into.unknownPositive.add(from.unknownPositive)
  if (!from.netBasisComplete) into.netBasisComplete = false
  if (!from.grossBasisComplete) into.grossBasisComplete = false
}

/** The credit that is the same unit as a figure on `basis`, and is therefore SUBTRACTED from it. */
export function comparableCredit(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): Prisma.Decimal {
  return basis === 'NET' ? buckets.net : buckets.gross
}

/**
 * THE CREDIT A FIGURE COULD NOT ABSORB, AS THE INTERVAL IT ACTUALLY OCCUPIES — never as one signed
 * amount, because one signed amount is what loses the cancellation.
 *
 * `[lower, upper]` is stated in the FIGURE'S unit and bounds the credit that was left unsubtracted,
 * so the true figure lies in `[published − upper, published − lower]`.
 *
 * On a NET figure the bound is TIGHT in both directions: a GROSS entry `g` is worth `g / (1 + rate)`
 * ex-VAT, which lies in `[0, g]` for `g >= 0` and in `[g, 0]` for `g < 0`, and an entry of unproven
 * basis is worth either itself or that, so the same interval covers it.
 *
 * On a GROSS figure only the DIRECTION is established, which is all `netLinearFigureBoundDecimal`
 * reads from it (its own docstring says so): a NET entry `n` is worth `n * (1 + rate)` VAT-inclusive
 * and has no finite ceiling, so `upper` is a sign carrier there and not a magnitude. `lower` is
 * still sign-correct — it is below zero exactly when some unplaced entry was negative, which is
 * exactly when the published figure may be too LOW and no `≤` may be claimed.
 */
export type UnplacedCreditInterval = { lower: Prisma.Decimal; upper: Prisma.Decimal }

export function unplacedCreditInterval(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): UnplacedCreditInterval {
  const zero = new Prisma.Decimal(0)
  const unplaced: Array<[Prisma.Decimal, Prisma.Decimal]> = basis === 'NET'
    ? [[buckets.gross, buckets.grossPositive], [buckets.unknown, buckets.unknownPositive]]
    : [[buckets.net, buckets.netPositive], [buckets.unknown, buckets.unknownPositive]]
  return unplaced.reduce<UnplacedCreditInterval>((interval, [total, positive]) => ({
    // Σ min(b, 0) = total − Σ max(b, 0). The two fields are all the endpoints need.
    lower: interval.lower.add(total.sub(positive)),
    upper: interval.upper.add(positive),
  }), { lower: zero, upper: zero })
}

export function addUnplacedIntervals(a: UnplacedCreditInterval, b: UnplacedCreditInterval): UnplacedCreditInterval {
  return { lower: a.lower.add(b.lower), upper: a.upper.add(b.upper) }
}

/**
 * The one number `netLinearFigureBoundDecimal` and `marginFigureBoundDecimal` take, derived from the
 * interval rather than from a sum.
 *
 * Both classifiers read a NEGATIVE value as "no `≤` claim holds", so a below-zero lower end is
 * handed straight to them and produces `indeterminate`; otherwise the credit provably cannot be
 * negative and the ceiling is the interval's upper end.
 */
export function unplacedCreditBound(interval: UnplacedCreditInterval): CollapsedUnplacedCreditDecimal {
  return collapseUnplacedCreditDecimal(interval)
}

/** The bound input for the credit a figure on `basis` could not absorb. */
export function unplacedCredit(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): CollapsedUnplacedCreditDecimal {
  return unplacedCreditBound(unplacedCreditInterval(buckets, basis))
}

export function creditBasisComplete(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): boolean {
  return basis === 'NET' ? buckets.netBasisComplete : buckets.grossBasisComplete
}

/** What off-row credit does to a report's figures, decided WITHOUT ever adding its bases together. */
export type OffRowCreditSummary = {
  /**
   * True when the off-row credit can move the figures at all. Decided from the INTERVAL, never from
   * a signed sum and never from a bucket total:
   *   - +100 GROSS and −100 NET add to zero while both still sit off every row (the cross-basis
   *     cancellation), and
   *   - +120 GROSS and −120 GROSS collapse to a zero GROSS BUCKET while their ex-VAT values need
   *     not cancel at all, since the rates behind them may differ (the same-basis cancellation).
   * Only when both endpoints are zero is nothing unaccounted for, and only then may a report call
   * its revenue, profit and margin exact.
   */
  present: boolean
  /**
   * The interval, IN NET TERMS, on the off-row credit that no row subtracted.
   *
   * Off-row credit reached no row, so even the NET-basis part of it is missing from the figures —
   * that part is added at BOTH endpoints, exactly, because it needs no conversion. The GROSS and
   * unproven parts contribute `unplacedCreditInterval`'s per-entry interval. Sum:
   *   `[ Σnet + Σ min(b, 0) , Σnet + Σ max(b, 0) ]`, over the ENTRIES, not the buckets.
   * A lower end below zero means the unsubtracted credit may itself be negative, so the published
   * figures are not ceilings and `unplacedCreditBound` turns that into `indeterminate`.
   */
  interval: UnplacedCreditInterval
}

export function offRowCreditSummary(...sets: CreditBuckets[]): OffRowCreditSummary {
  const merged = emptyCredits()
  for (const set of sets) mergeCredits(merged, set)
  const convertible = unplacedCreditInterval(merged, 'NET')
  const interval = {
    lower: merged.net.add(convertible.lower),
    upper: merged.net.add(convertible.upper),
  }
  return { present: !(interval.lower.isZero() && interval.upper.isZero()), interval }
}

/**
 * A FRACTION OF A BUCKET SET — for a report that splits one sales line's figures across several rows.
 *
 * The COGS report allocates each sales line's revenue across the groups that fulfilled it in
 * proportion to the quantity each group shipped (a split-warehouse dispatch produces two COGS
 * movements against one line, and counting the whole line revenue in both double-counts the report
 * total — cogs-audit scjz.50). The credit against that line has to follow the SAME allocation or the
 * two halves of the subtraction are on different denominators.
 *
 * SCALING BY A NON-NEGATIVE FACTOR IS THE ONLY KIND THAT PRESERVES THE ENDPOINTS, and that is why
 * the share is asserted rather than documented. `Σ max(k·e, 0) = k · Σ max(e, 0)` holds for `k >= 0`
 * and FAILS for `k < 0`, which would silently swap the interval's ends and turn a ceiling into a
 * claim the figure cannot support. The completeness flags are carried through unchanged: a credit
 * that could not be placed on a figure's basis is no more placeable for having been shared out, and
 * an exactly-zero share of an unplaceable credit still came from one (the amount rounds away, the
 * blindness does not — the same "dust is still value" rule `creditPlacement` applies).
 */
export function scaleCredits(buckets: CreditBuckets, numerator: Prisma.Decimal, denominator: Prisma.Decimal): CreditBuckets {
  if (numerator.lt(0) || denominator.lte(0)) {
    throw new Error(`scaleCredits requires a non-negative share, got ${numerator.toString()}/${denominator.toString()}`)
  }
  // MULTIPLY THEN DIVIDE, in that order, because the caller's revenue allocation does. Decimal
  // division is exact only to a finite precision, so `credit.mul(q).div(total)` and
  // `credit.mul(q.div(total))` differ in the last digits whenever `q/total` does not terminate — and
  // three groups sharing a line by thirds would leave the credit summing to slightly less than the
  // revenue it is subtracted from. Same expression shape, same residual, no drift between the halves.
  const share = (value: Prisma.Decimal) => value.mul(numerator).div(denominator)
  return {
    net: share(buckets.net),
    gross: share(buckets.gross),
    unknown: share(buckets.unknown),
    netPositive: share(buckets.netPositive),
    grossPositive: share(buckets.grossPositive),
    unknownPositive: share(buckets.unknownPositive),
    netBasisComplete: buckets.netBasisComplete,
    grossBasisComplete: buckets.grossBasisComplete,
  }
}

/**
 * THE CREDIT A ROW COULD NOT ABSORB AT ALL — because the row publishes no figure to absorb it.
 *
 * `offRowCreditSummary` in the same shape, but for credit that DID reach a row whose figure is
 * withheld (the COGS report prints `Unmatched` where a dispatch could not be tied to a sales line,
 * and there is no revenue there to subtract from). Even the same-basis part of that credit is
 * missing from the period figure, so it is added at BOTH endpoints; the parts on another basis
 * contribute their per-entry interval, exactly as everywhere else.
 */
export function unabsorbedCreditInterval(buckets: CreditBuckets, basis: 'NET' | 'GROSS'): UnplacedCreditInterval {
  const comparable = comparableCredit(buckets, basis)
  const rest = unplacedCreditInterval(buckets, basis)
  return { lower: comparable.add(rest.lower), upper: comparable.add(rest.upper) }
}
