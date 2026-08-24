import { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-8u4h round 3: MAKING THE ROW ADD UP, ON PURPOSE AND IN ONE PLACE.
 *
 * -----------------------------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 * -----------------------------------------------------------------------------------------------
 * The supplier-aging report publishes a total and then publishes its parts, and it told the reader
 * to check the row: "billedAmount = billedWithPaymentMarker + billedWithoutPaymentMarker, which the
 * reader can check across the row", and the four age bands likewise adding back to the without-
 * marker total. That check was the whole justification for splitting the figure at all.
 *
 * But `PurchaseInvoice.totalBase` is stored to FOUR decimal places, and the action rounded the
 * parent and every component INDEPENDENTLY to two. Independent rounding does not distribute over
 * addition: two bills of 5.005 and 10.005 sum to 15.01, while the halves round to 5.01 and 10.01
 * and come to 15.02. The report published both numbers on the same row and invited the reader to
 * add them up. A penny is small; a total that does not equal its parts, on a page whose stated
 * point is that the reader can verify it, is not.
 *
 * -----------------------------------------------------------------------------------------------
 * THE POLICY, STATED ONCE
 * -----------------------------------------------------------------------------------------------
 *   1. AGGREGATE EXACTLY. Every accumulator is a `Prisma.Decimal`, summed at full stored precision.
 *      No float, and no rounding of an individual bill before it is added to anything — rounding
 *      each bill first gives a different penny, which this report's existing test already pins.
 *
 *   2. ROUND THE PARENT ONCE, from its own exact sum, to the minor unit (2dp), ROUND_HALF_UP —
 *      half away from zero, the money convention. The parent is the figure of record; it is never
 *      re-derived by adding rounded parts, because that would let two roundings compound.
 *
 *   3. ROUND EACH COMPONENT ONCE, from its own exact sum, the same way.
 *
 *   4. RECONCILE. residue = parent − Σ components, in whole minor units. It is zero most of the
 *      time and is bounded by half a minor unit per component (so at most 2p across four age
 *      bands). THE WHOLE RESIDUE IS ADDED TO THE COMPONENT WITH THE LARGEST ABSOLUTE EXACT VALUE,
 *      ties broken by position — the earliest of the equal-largest. Landing it on the largest
 *      component is the choice that makes the adjustment the smallest fraction of the number it
 *      lands on, and putting it all in one place rather than spreading it keeps the answer
 *      reproducible from the row: the reader can see which cell absorbed it by re-doing the sum.
 *
 * SO THE PUBLISHED COMPONENTS SUM TO THE PUBLISHED PARENT, EXACTLY, IN THE MINOR UNIT — on screen
 * and in the CSV, which read the same numbers.
 *
 * WHAT THIS IS NOT. It is not a claim that any single component is exact to the penny; one of them
 * carries up to a penny of the report's rounding residue, by an explicit rule rather than by
 * accident. That is the honest trade: an exact parent, exact-to-a-penny components, and an identity
 * that holds — versus three "independently correct" numbers that contradict each other.
 *
 * CHAIN IT FOR A NESTED SPLIT. Where a component is itself split (the age bands under the
 * without-marker total), pass the PUBLISHED component as the next parent — not its exact sum — or
 * the children reconcile to a number the page never shows.
 */

/** Round half away from zero, the money convention, matching the report's previous `Math.round`. */
const ROUND_HALF_UP = Prisma.Decimal.ROUND_HALF_UP

/** Two decimal places: this report is published in the base currency's minor unit. */
const MINOR_UNIT_SCALE = 100

export type ReconciledSplit = {
  /** The parent, rounded once from its own exact sum. */
  parent: number
  /** The components, rounded once each, with the residue placed by the rule above. */
  components: number[]
}

/** Exact Decimal -> whole minor units. */
function toMinorUnits(value: Prisma.Decimal): number {
  return value.mul(MINOR_UNIT_SCALE).toDecimalPlaces(0, ROUND_HALF_UP).toNumber()
}

/** Whole minor units -> the major-unit number the report publishes. */
export function fromMinorUnits(minor: number): number {
  return minor / MINOR_UNIT_SCALE
}

/** A single figure, rounded once from its exact sum. Same rounding as everything else here. */
export function roundToMinorUnit(value: Prisma.Decimal): number {
  return fromMinorUnits(toMinorUnits(value))
}

/**
 * Which component absorbs the residue: the largest by absolute EXACT value, earliest wins a tie.
 *
 * Absolute rather than signed, because a credit-shaped component is still a big number and is still
 * the one least distorted by a penny. Exact rather than rounded, because the rounded values are
 * what the residue came from.
 */
function residueTarget(exactComponents: readonly Prisma.Decimal[]): number {
  let best = 0
  for (let index = 1; index < exactComponents.length; index += 1) {
    if (exactComponents[index].abs().gt(exactComponents[best].abs())) best = index
  }
  return best
}

/**
 * Publish a parent and its components so that the components sum to the parent in the minor unit.
 *
 * The components MUST be an exhaustive, non-overlapping partition of the parent — every bill in
 * exactly one marker group, every unmarked bill in exactly one age band. If they are not, the
 * "residue" is a real discrepancy and this would hide it in one cell; that is a modelling error, so
 * it is asserted rather than absorbed.
 */
export function reconcileMinorUnits(
  exactParent: Prisma.Decimal,
  exactComponents: readonly Prisma.Decimal[],
): ReconciledSplit {
  const parentMinor = toMinorUnits(exactParent)
  const componentsMinor = exactComponents.map(toMinorUnits)
  if (componentsMinor.length === 0) return { parent: fromMinorUnits(parentMinor), components: [] }

  const residue = parentMinor - componentsMinor.reduce((total, value) => total + value, 0)
  // A partition can only ever be out by the rounding of its own members: half a minor unit each,
  // rounded up. Anything larger means the components are not a partition of this parent, and
  // silently absorbing it would publish a reconciliation that is a lie about the data rather than
  // about the rounding.
  const maxResidue = Math.ceil(componentsMinor.length / 2) + 1
  if (Math.abs(residue) > maxResidue) {
    throw new Error(
      `reconcileMinorUnits: components are not a partition of the parent — residue ${residue} minor units exceeds the ${maxResidue} that rounding can explain`,
    )
  }
  if (residue !== 0) componentsMinor[residueTarget(exactComponents)] += residue

  return { parent: fromMinorUnits(parentMinor), components: componentsMinor.map(fromMinorUnits) }
}
