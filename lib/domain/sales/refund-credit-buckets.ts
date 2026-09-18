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
 * Lifted out of `sales-fulfillment-analytics.ts` by o3d-rv4a WITHOUT a change of behaviour. The Decimal
 * reports (Sales Analytics, Customer Mix, Gross Margin) use it.
 *
 * THE COGS REPORT DOES NOT, AND THAT IS A DELIBERATE SECOND COPY (o3d-rv4a r5). The COGS report splits a
 * line's credit across groups by quantity share, and a Decimal share rounds at twenty significant
 * digits; the independent review of r5 found that rounding flipping a verdict (a credit share exactly
 * equal to a revenue share came out unequal). So `inventory-costing-reports.ts` holds the same buckets
 * EXACTLY (`ExactCredit`, `addExactCredit`, `exactUnplacedInterval`, `exactUnabsorbedInterval`). A second
 * copy is the failure this line of work keeps finding, so the two are tied together by a parity test
 * over shared fixtures (tests/analytics/cogs-exact-credit-parity.test.ts): same buckets, same positive
 * parts, same placement flags, same intervals, entry for entry.
 *
 * Everything below is the o3d-kyey text verbatim plus the exports.
 */

/**
 * WHICH PERIOD A CREDIT BELONGS TO — the one clause every basis-aware report builds its refund query
 * from (o3d-rv4a r2, Codex round 2 HIGH 1).
 *
 * A credit belongs to the period it was RAISED in, by its own `refundedAt`, which is what a credit
 * note does to a month's accounts: one raised now against an earlier dispatch reduces this period,
 * and one raised later against a dispatch in this period is not loaded, so a closed period's figures
 * stay the figures as they stood.
 *
 * IT IS A SHARED FUNCTION RATHER THAN A SHARED CONVENTION BECAUSE ROUND 1 PROVED THE CONVENTION DOES
 * NOT HOLD. The COGS report claimed this rule in a docstring and then added `orderId: { in:
 * sourceOrderIds }` beside it — narrowing the load to the orders behind the window's own dispatches.
 * That looked like a tightening and was a defect in BOTH directions: it dropped in-period credit
 * against earlier-period orders, which Gross Margin loads and deducts, so COGS published exact
 * revenue over a period with a credit note missing from it; and it was no help at all against the
 * thing it was reaching for, since credit for a FILTERED-OUT sibling product on an included order
 * passed the order test and landed in the off-report bucket, marking a filtered view bounded for a
 * reason that was not about the view.
 *
 * The lesson is that the PERIOD and the report's own FILTERS are two different questions and one
 * clause cannot answer both. This function answers only the first, identically for every caller;
 * a report that must also apply its filters does that separately and visibly.
 */
export type RefundPeriodWhere = { refund: { refundedAt: { gte: Date; lt: Date } } }

export function refundLinesRaisedInPeriodWhere(from: Date, toExclusive: Date): RefundPeriodWhere {
  return { refund: { refundedAt: { gte: from, lt: toExclusive } } }
}

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
