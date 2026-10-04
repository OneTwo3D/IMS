import { Prisma } from '@/app/generated/prisma/client'

/**
 * THE ONE SENTENCE every surface uses when the zero floor absorbed part of a negative landed cost: the
 * recalculation's warning (and so the revaluation run's `warningsJson`), the activity entry, the receipt
 * result and the PO detail badge all call `describeFlooredLandedCredit`, so they cannot drift apart.
 * tests/domain/purchasing/landed-cost-allocation.test.ts fails if the phrase below appears anywhere else.
 *
 * FACTS ONLY. It states what IMS did with its own numbers (valued the units at zero, could not absorb an
 * exact amount, queued no journal for that amount). It gives NO instruction to post, reverse or adjust
 * anything and makes NO claim about what the ledger holds: whether a supplier document, a journal or
 * nothing at all stands behind that amount is the operator's to establish, not something IMS has proof of.
 * The wording also avoids the verbs the ledger-standing checkers treat as money instructions.
 */
export type FlooredLandedCreditEntry = {
  /** What the operator calls the line (a SKU, a line number); falls back to the id upstream. */
  label: string
  /** Exact; what the floor could not absorb for the units concerned. */
  unabsorbedBase: Prisma.Decimal
  /** The 6dp unit cost before the floor, strictly negative. */
  unflooredGrossUnitCostBase: Prisma.Decimal
}

function money(value: Prisma.Decimal): string {
  return value.toFixed(2, Prisma.Decimal.ROUND_HALF_UP)
}

export function totalUnabsorbedBase(entries: FlooredLandedCreditEntry[]): Prisma.Decimal {
  return entries.reduce((sum, entry) => sum.add(entry.unabsorbedBase), new Prisma.Decimal(0))
}

export function describeFlooredLandedCredit(params: {
  context: string
  entries: FlooredLandedCreditEntry[]
}): string {
  const { context, entries } = params
  const detail = entries
    .map((entry) => `${entry.label}: ${money(entry.unabsorbedBase)} (unit cost would have been ${entry.unflooredGrossUnitCostBase.toFixed(6)})`)
    .join('; ')
  return `${context}: a negative landed cost was larger than the goods cost of ${entries.length} line(s), `
    + `so IMS valued those units at 0.00 each and could not absorb ${money(totalUnabsorbedBase(entries))} of it into stock `
    + `[${detail}]. IMS queued no journal for that amount.`
}
