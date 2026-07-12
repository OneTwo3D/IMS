import { roundQuantity, type Decimal, type DecimalInput } from './decimal'

/**
 * Canonical subledger / GL precision policy (cogs-audit scjz.60).
 *
 * One conceptual base-currency amount is carried at three different precisions
 * across the system, and that is intentional — but it must be coordinated so
 * the subledgers reconcile rather than drift:
 *
 *   - INVENTORY_COST_PRECISION (6dp): cost layers, the FIFO engine, cogs_entries,
 *     stock quantities. Sub-penny unit costs are required so that
 *     `remainingQty * unitCostBase` stays accurate across many small movements.
 *   - DOCUMENT_BASE_PRECISION (4dp): PO/SO line and invoice `*Base` totals — the
 *     document subledger amounts as agreed with the customer/supplier.
 *   - GL_BASE_PRECISION (2dp): every General Ledger posting. The base currency is
 *     GBP (2 minor-unit digits); the daily batch and all journals post in the
 *     base currency, so GL amounts are always rounded to this precision.
 *
 * Rules (the contract every posting and every rounding-residue fix follows):
 *   1. GL postings round to GL_BASE_PRECISION using ROUND_HALF_UP (see roundMoney
 *      / roundQuantity in ./decimal — the single rounding mode in the system).
 *   2. Postings derive their amount from the stored document/subledger `*Base`
 *      value, never by re-deriving `foreign * rate` (re-derivation drifts because
 *      the rate is itself rounded — see the FX bookedBase findings).
 *   3. The irreducible residue when a 6dp inventory value posts to a 2dp GL is
 *      reconciled explicitly (cogs-audit scjz.60c) rather than left to silently
 *      accumulate; until that rounding-difference account is configured, residue
 *      within the tolerances below is treated as immaterial by the reconciliation
 *      invariants.
 *
 * This module is the single source of truth for those precisions and tolerances
 * so the magic numbers 2/4/6 are not scattered and cannot drift per call site.
 */

/** 6dp — cost layers, FIFO engine, cogs_entries, stock quantities. */
export const INVENTORY_COST_PRECISION = 6

/** 4dp — PO/SO line and invoice `*Base` document totals. */
export const DOCUMENT_BASE_PRECISION = 4

/** 2dp — every base-currency General Ledger posting (GBP minor units). */
export const GL_BASE_PRECISION = 2

/**
 * Reconciliation tolerances for "the subledger ties to the GL" invariants. A
 * single 6dp→2dp boundary loses at most half a minor unit; these allow for a
 * few such crossings per line / per aggregated journal before a divergence is
 * treated as a real (non-rounding) discrepancy.
 */
export const GL_LINE_TOLERANCE = 0.01
export const GL_JOURNAL_TOLERANCE = 0.05

/** Round a base-currency amount to the canonical GL posting precision (Decimal). */
export function roundToGlPrecision(value: DecimalInput): Decimal {
  return roundQuantity(value, GL_BASE_PRECISION)
}

/**
 * Round a base-currency amount to the canonical GL posting precision (number).
 *
 * Delegates to the Decimal path so it honours ROUND_HALF_UP for BOTH signs and
 * stays bit-identical to roundToGlPrecision / round2Decimal. A naive
 * `Math.round(v * 100) / 100` rounds negative ties toward +Infinity
 * (e.g. -1.005 -> -1.00 instead of -1.01), which would create penny mismatches
 * on reversal/credit-style GL postings (cogs-audit scjz.60a).
 */
export function roundToGlPrecisionNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Invalid GL amount: ${value}`)
  }
  return roundToGlPrecision(value).toNumber()
}
