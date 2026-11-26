import { Prisma } from '@/app/generated/prisma/client'

/**
 * THE ONE LANDED-COST ALLOCATION.
 *
 * "What does one unit of this purchase-order line cost once the order's own cost lines and its linked
 * freight orders' cost lines are spread over it" has exactly one definition, here. Six places need the
 * answer and all of them call this module: the PO detail preview, the manual receipt, the WMS book-in, the
 * WMS stock-sync align-up (those four through `computeGrossUnitCostBaseByLine` in landed-cost-service.ts)
 * and the two revaluation paths, `recalculateLandedCosts` and `recalculateDirectLandedCosts`.
 *
 * WHY IT IS ITS OWN FILE. Before this module the receipt-side helper SKIPPED every non-positive cost line
 * while the revaluation paths distributed all of them, so a purchase order carrying a credit freight line
 * was received at one cost and revalued at another, and the revaluation posted a reclass for a difference
 * that was an artefact of which code path ran. Agreement is now by construction: there is no second loop to
 * disagree with. tests/domain/purchasing/landed-cost-allocation.test.ts also reads the source and fails if
 * a second distribution loop or a sign filter on a cost line reappears.
 *
 * THE RULES (each is a test row):
 *  1. Every cost line is distributed whatever its sign. A zero line distributes zero by arithmetic, not by
 *     being skipped.
 *  2. Deterministic order: cost lines by CONTENT (sourceRank, amount, method), lines by id. Decimal division is rounded to the
 *     configured precision, so the order the shares are summed in can move the last digit; a database read
 *     with no ORDER BY must not be able to do that.
 *  3. A line is eligible when its qty is greater than zero. The basis is `computeDistributionBase`. An
 *     all-zero basis falls back to an equal split.
 *  4. The gross unit cost is `unitCost + landed/qty`, rounded to 6dp HALF_UP, and ONLY THEN floored at zero
 *     (the owner's decision: a credit reduces inventory basis, but a unit is never valued below zero).
 *     Flooring after rounding, and never returning a signed zero, are both deliberate and both tested.
 *  5. No I/O and no logging. The preview calls this and must stay read-only; callers decide what to persist.
 *
 * THE FLOOR IS PER PO LINE, hence identical for every layer of the line: the revaluation writes one gross
 * unit cost to every layer of a line and the receipt writers create layers at that same figure. The part of
 * a credit that cannot be absorbed is NOT redistributed onto other lines (that would change what the
 * allocation method means); it is reported in `floors` for the caller to surface.
 */

export const LANDED_COST_DISTRIBUTION_METHODS = [
  'BY_VALUE',
  'BY_QUANTITY',
  'BY_WEIGHT',
  'EQUAL_SPLIT',
] as const

export type LandedCostDistributionMethod = typeof LANDED_COST_DISTRIBUTION_METHODS[number]

export function normalizeLandedCostMethod(
  method: string | null | undefined,
): LandedCostDistributionMethod {
  return LANDED_COST_DISTRIBUTION_METHODS.includes(method as LandedCostDistributionMethod)
    ? method as LandedCostDistributionMethod
    : 'BY_VALUE'
}

type DecimalInput = Prisma.Decimal | number | string

type DistributionLine = {
  qty: Prisma.Decimal
  totalBase: Prisma.Decimal
  product: { weight: Prisma.Decimal | null }
}

function decimal(value: DecimalInput | null | undefined): Prisma.Decimal {
  return new Prisma.Decimal(value ?? 0)
}

export function computeDistributionBase(
  line: DistributionLine,
  method: LandedCostDistributionMethod,
): Prisma.Decimal {
  switch (method) {
    case 'BY_WEIGHT':
      return decimal(line.product.weight).mul(line.qty)
    case 'BY_QUANTITY':
      // Per-unit distribution: a 1000-unit line absorbs 1000× a 1-unit line.
      return decimal(line.qty)
    case 'EQUAL_SPLIT':
      // nmim: EQUAL_SPLIT weights each LINE equally (base 1/line) REGARDLESS of
      // quantity — this is intentional, the distinct "split freight evenly across
      // line items" option. Callers wanting per-unit distribution use BY_QUANTITY.
      return new Prisma.Decimal(1)
    case 'BY_VALUE':
    default:
      return decimal(line.totalBase)
  }
}

export type LandedAllocationLine = {
  id: string
  qty: DecimalInput
  unitCostBase: DecimalInput
  totalBase: DecimalInput
  weight?: DecimalInput | null
  /**
   * The surviving fraction of the line's goods cost after the order's HEADER discount (see
   * `headerDiscountFactorForPo`). Absent = 1. `unitCostBase` on a PO line is the line-discounted,
   * VAT-extracted price BEFORE the header discount, so a layer valued at it alone is worth more than the
   * bill that pays for it and the difference is stranded in Stock in Transit.
   */
  headerDiscountFactor?: DecimalInput | null
  /**
   * Per-event FX (switch `purchase_event_fx_rates_enabled`): the GOODS unit cost in base currency at the rate the policy locked for these goods,
   * already after the header discount (6dp, `lib/domain/purchasing/purchase-receipt-fx.ts`). When set it REPLACES `unitCostBase` x
   * `headerDiscountFactor` as the goods part of the gross cost; the freight share is unchanged (its distribution basis is still `totalBase`, and
   * every line of one order is in the one currency, so the proportions do not depend on the rate). Absent or null = exactly as before.
   */
  goodsUnitCostBase?: DecimalInput | null
}

/**
 * The fraction of every line's goods cost that survives the order's header discount, READ BACK from the
 * stored totals: `subtotalBase / SUM(line.totalBase)`. applyHeaderOrderDiscount reduces the net subtotal by
 * one amount and never revisits the lines, so every line keeps the same fraction of its cost (the same basis
 * return-credit-basis.ts uses for the credit on a return). 1 when there is nothing to take a proportion of,
 * when the stored subtotal is missing, when it is not below the line sum (a discount can only reduce it), or
 * when the gap is under half a pip (rounding, not a discount) so an undiscounted order is untouched.
 */
export function headerDiscountFactorForPo(po: {
  subtotalBase: DecimalInput | null | undefined
  lines: { totalBase: DecimalInput | null | undefined }[]
}): Prisma.Decimal {
  const one = new Prisma.Decimal(1)
  if (po.subtotalBase == null) return one
  const lineSum = po.lines.reduce((sum, l) => sum.add(decimal(l.totalBase)), new Prisma.Decimal(0))
  if (!lineSum.gt(0)) return one
  const subtotal = decimal(po.subtotalBase)
  if (subtotal.gte(lineSum) || lineSum.sub(subtotal).lt(new Prisma.Decimal('0.0001'))) return one
  if (subtotal.lt(0)) return new Prisma.Decimal(0)
  return subtotal.div(lineSum)
}

/**
 * The goods part of a unit's cost: the line's `unitCostBase` after the order's header discount, with NO freight in it. The one definition the
 * landed-cost allocation starts from and the GR/IR accrual values a receipt and a bill with, so the two cannot disagree about what the goods cost.
 */
export function goodsUnitCostAfterHeaderDiscount(unitCostBase: DecimalInput, headerDiscountFactor: DecimalInput | null | undefined): Prisma.Decimal {
  const unit = decimal(unitCostBase)
  return headerDiscountFactor == null ? unit : unit.mul(decimal(headerDiscountFactor))
}

function effectiveGoodsUnitCost(line: LandedAllocationLine): Prisma.Decimal {
  if (line.goodsUnitCostBase != null) return decimal(line.goodsUnitCostBase)
  return goodsUnitCostAfterHeaderDiscount(line.unitCostBase, line.headerDiscountFactor)
}

/**
 * THE GROSS UNIT COST OF ONE GOODS COST: goods + this line's landed share per unit, 6dp HALF_UP, then the zero floor. The one formula the allocation
 * below uses for every line and the landed-cost recalculation uses for a cost layer that carries its own `goodsUnitCostBase` (per-event FX), so a
 * layer laid at receipt and the same layer revalued later cannot differ for the same cost lines. `qty` must be > 0.
 */
export function grossUnitCostForGoods(
  goodsUnitCostBase: DecimalInput,
  landedAmountBase: DecimalInput,
  qty: DecimalInput,
): { gross: Prisma.Decimal; unfloored: Prisma.Decimal } {
  const unfloored = decimal(goodsUnitCostBase)
    .add(decimal(landedAmountBase).div(decimal(qty)))
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP)
  return { gross: floorUnitCostAtZero(unfloored), unfloored }
}

/** 0 = the order's own (direct) cost lines; 1 = the cost lines of the freight orders linked to it. */
export type LandedAllocationSourceRank = 0 | 1

export type LandedAllocationCostLine = {
  /** Identifies the line in warnings only; it takes no part in the arithmetic or its order. */
  id?: string | null
  amountBase: DecimalInput
  distributionMethod: string | null | undefined
  sourceRank: LandedAllocationSourceRank
}

/** Something a caller may want to warn about, in the order the cost lines were processed. */
export type LandedAllocationEvent =
  | { kind: 'weight_fallback'; sourceRank: LandedAllocationSourceRank; costLineId: string | null }
  | { kind: 'weight_zero_line'; sourceRank: LandedAllocationSourceRank; costLineId: string | null; lineIds: string[] }

export type LandedAllocationFloor = {
  lineId: string
  qty: Prisma.Decimal
  /** The 6dp gross unit cost BEFORE the floor; strictly negative. */
  unflooredGrossUnitCostBase: Prisma.Decimal
  /** What the floor could not absorb, per unit: `-unflooredGrossUnitCostBase`. */
  unabsorbedPerUnitBase: Prisma.Decimal
}

export type LandedAllocation = {
  /** FLOORED, 6dp HALF_UP, never a signed zero. A line with qty <= 0 carries its goods cost unchanged. */
  grossUnitCostBaseByLine: Map<string, Prisma.Decimal>
  /** The signed, unrounded amount allocated to each line (0 for a line with qty <= 0). */
  landedAmountByLine: Map<string, Prisma.Decimal>
  /** Only the lines whose 6dp gross unit cost was strictly negative before the floor. */
  floors: LandedAllocationFloor[]
  events: LandedAllocationEvent[]
}

/**
 * THE ONE FLOOR. Zero stays zero, a negative becomes ZERO, and a signed zero (Decimal keeps `-0`, whose
 * `toNumber()` is `-0` and whose `toString()` is `'0'` only some of the time) is normalised to a positive
 * zero here, so it cannot reach a column, a JSON audit row or a `Stock movement unit cost` check.
 */
export function floorUnitCostAtZero(value: Prisma.Decimal): Prisma.Decimal {
  return value.lte(0) ? new Prisma.Decimal(0) : value
}

/** What a floored unit cost left unabsorbed over `qty` units, exact Decimal (never negative). */
export function unabsorbedBaseForQty(unflooredGrossUnitCostBase: Prisma.Decimal, qty: DecimalInput): Prisma.Decimal {
  const perUnit = unflooredGrossUnitCostBase.lt(0) ? unflooredGrossUnitCostBase.neg() : new Prisma.Decimal(0)
  return perUnit.mul(decimal(qty))
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function allocateLandedCost(
  lines: LandedAllocationLine[],
  costLines: LandedAllocationCostLine[],
): LandedAllocation {
  const orderedLines = [...lines].sort((a, b) => compareIds(a.id, b.id))
  // ORDER BY CONTENT, never by id or insertion order. Ids are renumbered whenever a freight order's lines are
  // saved (they are deleted and recreated), and a read has no ORDER BY, so an order that involved either would
  // let a save that changed nothing move a cost line past another and change a 6dp unit cost (Decimal rounds
  // each share to 20 significant digits, so the summation order is observable). Two cost lines with the same
  // (sourceRank, amount, method) produce the same share, so they are interchangeable and their relative order
  // cannot matter; ties keep the input order only so warnings stay in a stable order. Everything else about a
  // cost line (id, description, which freight order it sits on) takes no part in the arithmetic.
  const orderedCostLines = [...costLines].sort((a, b) => (
    a.sourceRank - b.sourceRank
    || decimal(a.amountBase).cmp(decimal(b.amountBase))
    || compareIds(normalizeLandedCostMethod(a.distributionMethod), normalizeLandedCostMethod(b.distributionMethod))
  ))
  const eligibleLines = orderedLines.filter((line) => decimal(line.qty).gt(0))

  const landedByLine = new Map<string, Prisma.Decimal>()
  for (const line of orderedLines) landedByLine.set(line.id, new Prisma.Decimal(0))
  const events: LandedAllocationEvent[] = []

  for (const costLine of orderedCostLines) {
    const amountBase = decimal(costLine.amountBase)
    const method = normalizeLandedCostMethod(costLine.distributionMethod)
    const costLineId = costLine.id ?? null
    const bases = eligibleLines.map((line) => ({
      lineId: line.id,
      base: computeDistributionBase(
        {
          qty: decimal(line.qty),
          totalBase: decimal(line.totalBase),
          product: { weight: decimal(line.weight) },
        },
        method,
      ),
    }))
    let basisTotal = bases.reduce((sum, entry) => sum.add(entry.base), new Prisma.Decimal(0))
    if (basisTotal.lte(0)) {
      // Reported only when the line actually moves money: a zero line distributes nothing, so a fallback on
      // it would warn about an allocation that never happened. A credit line falling back IS meaningful.
      if (method === 'BY_WEIGHT' && !amountBase.isZero()) {
        events.push({ kind: 'weight_fallback', sourceRank: costLine.sourceRank, costLineId })
      }
      basisTotal = new Prisma.Decimal(eligibleLines.length || 1)
      for (const entry of bases) entry.base = new Prisma.Decimal(1)
    } else if (amountBase.gt(0)) {
      // Positive freight only (scjz.17): a zero line assigns nothing, and widening this to credits is a
      // separate change.
      const zeroWeightLineIds = method === 'BY_WEIGHT'
        ? bases.filter((entry) => entry.base.lte(0)).map((entry) => entry.lineId)
        : []
      if (zeroWeightLineIds.length > 0) {
        events.push({ kind: 'weight_zero_line', sourceRank: costLine.sourceRank, costLineId, lineIds: zeroWeightLineIds })
      }
    }
    for (const entry of bases) {
      const share = amountBase.mul(entry.base).div(basisTotal)
      landedByLine.set(entry.lineId, decimal(landedByLine.get(entry.lineId)).add(share))
    }
  }

  const grossUnitCostBaseByLine = new Map<string, Prisma.Decimal>()
  const floors: LandedAllocationFloor[] = []
  for (const line of orderedLines) {
    const qty = decimal(line.qty)
    if (qty.lte(0)) {
      grossUnitCostBaseByLine.set(line.id, effectiveGoodsUnitCost(line))
      continue
    }
    const rounded = grossUnitCostForGoods(effectiveGoodsUnitCost(line), decimal(landedByLine.get(line.id)), qty).unfloored
    if (rounded.lt(0)) {
      floors.push({
        lineId: line.id,
        qty,
        unflooredGrossUnitCostBase: rounded,
        unabsorbedPerUnitBase: rounded.neg(),
      })
    }
    grossUnitCostBaseByLine.set(line.id, floorUnitCostAtZero(rounded))
  }

  return { grossUnitCostBaseByLine, landedAmountByLine: landedByLine, floors, events }
}
