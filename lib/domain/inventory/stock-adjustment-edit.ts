// decimal-boundary-ok: server-action-boundary (numeric stock adjustment input validation)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'

const QUANTITY_EPSILON = 0.000001

// Mirror the shortfall tolerance consumeFifoLayersStrict applies (lib/cost-layers.ts):
// it accepts a remaining shortfall up to the 6dp engine scale (1e-6). The feasibility
// pre-check must use the SAME tolerance, or it would accept an edit that the real
// consumption then rejects (surfacing a misleading concurrent-consumption error).
const FIFO_SHORTFALL_TOLERANCE = QUANTITY_EPSILON

// Tolerance for guarding the literal stock_levels.quantity column (Decimal(14,6)) against
// going negative / below reserved. It MUST be strictly smaller than one representable unit
// (1e-6) — otherwise the guard would permit a removal that overshoots available by a whole
// representable unit, writing a real -0.000001 on-hand that only the DB non-negative CHECK
// then catches opaquely (ig58). It must also stay above double-precision representation noise
// on a difference of two 6dp values, which at the top of the (14,6) range (~1e8) is ~3e-8, so
// a legitimate exact-to-the-unit removal is never spuriously rejected. 1e-7 sits in that gap.
// (Distinct from QUANTITY_EPSILON, which is the 1e-6 FIFO engine-scale layer-sum tolerance.)
const STOCK_QUANTITY_FP_EPSILON = 0.0000001

export type AdjustmentStockDeltaInput = {
  oldSignedQty: number
  newSignedQty: number
  currentQuantity?: DecimalLike | null
  currentReservedQty?: DecimalLike | null
}

export type AdjustmentStockDelta = {
  stockDelta: number
  resultingQuantity: number
  reservedQty: number
}

export function calculateAdjustmentStockDelta({
  oldSignedQty,
  newSignedQty,
  currentQuantity,
  currentReservedQty,
}: AdjustmentStockDeltaInput): AdjustmentStockDelta {
  const stockDelta = newSignedQty - oldSignedQty
  const currentQty = decimalToNumber(currentQuantity ?? 0)
  const reservedQty = decimalToNumber(currentReservedQty ?? 0)
  const resultingQuantity = currentQty + stockDelta

  if (resultingQuantity + STOCK_QUANTITY_FP_EPSILON < reservedQty) {
    throw new Error(
      `Cannot edit adjustment: resulting stock (${resultingQuantity.toFixed(4)}) ` +
      `would be below reserved quantity (${reservedQty.toFixed(4)}).`,
    )
  }

  return { stockDelta, resultingQuantity, reservedQty }
}

export type ApplyStockAdjustmentFeasibilityInput = {
  /** Signed quantity of the NEW adjustment (positive = addition, negative = removal). */
  signedQty: number
  /** Current on-hand quantity on the locked stock-level row. */
  currentQuantity?: DecimalLike | null
  /** Current reserved (allocated / in-transit) quantity on the locked row. */
  currentReservedQty?: DecimalLike | null
}

/**
 * ig58: pre-flight feasibility for a NEW stock adjustment against the locked
 * stock-level row, BEFORE any movement/cost-layer/upsert is written. A removal
 * that would drive on-hand below the reserved quantity (stock committed to
 * orders / in transit) — which includes any removal that would go negative — is
 * rejected with a clear, actionable message instead of letting the DB
 * non-negative CHECK abort with an opaque constraint error. Mirrors
 * calculateAdjustmentStockDelta's reserved guard for the edit path; additions
 * are always feasible (a positive adjustment strictly increases on-hand, so it
 * can never newly drive quantity below reserved or negative — only the edit path
 * needs a both-signs guard, because an edit's net delta can be negative even when
 * the adjustment itself is an addition). Returns the resulting on-hand quantity.
 */
export function assertStockAdjustmentFeasible({
  signedQty,
  currentQuantity,
  currentReservedQty,
}: ApplyStockAdjustmentFeasibilityInput): { resultingQuantity: number; reservedQty: number } {
  const currentQty = decimalToNumber(currentQuantity ?? 0)
  const reservedQty = decimalToNumber(currentReservedQty ?? 0)
  const resultingQuantity = currentQty + signedQty
  const available = currentQty - reservedQty

  if (signedQty < 0 && Math.abs(signedQty) > available + STOCK_QUANTITY_FP_EPSILON) {
    throw new Error(
      `Insufficient stock to remove ${Math.abs(signedQty)} unit(s) — only ${available.toFixed(4)} available ` +
      `(${currentQty.toFixed(4)} on hand` +
      (reservedQty > 0 ? `, ${reservedQty.toFixed(4)} reserved for orders` : '') +
      `). Release reservations/allocations or reverse later movements first.`,
    )
  }

  return { resultingQuantity, reservedQty }
}

export type AdjustmentEditFifoFeasibilityInput = {
  /** True when the edited adjustment will ADD stock (creates a layer — always feasible). */
  newIsAddition: boolean
  /** Absolute quantity the edited adjustment will remove (only relevant when !newIsAddition). */
  newAbsQty: number
  /** Sum of remainingQty across all current cost layers for the product+warehouse. */
  currentRemainingLayerQty?: DecimalLike | null
  /**
   * Old REDUCTION being edited: total quantity this adjustment consumed (its CogsEntries),
   * which is restored to its source layers before re-consumption — so it re-enters the pool.
   * 0/omitted when the old movement was an addition.
   */
  restorableConsumedQty?: DecimalLike | null
  /**
   * Old ADDITION being edited: remainingQty of this adjustment's own layer, which is deleted
   * (removed from the pool) before any re-consumption. 0/omitted when the old movement was a
   * reduction.
   */
  removableLayerQty?: DecimalLike | null
}

/**
 * Decide whether an in-place adjustment edit that ends as a stock REDUCTION can be satisfied
 * by the FIFO cost layers that will exist *after* the edit's own cleanup (restoring the old
 * adjustment's consumed layers, or removing the old addition's layer) — BEFORE any of that
 * cleanup is written.
 *
 * consumeFifoLayersStrict only fails on total insufficiency (FIFO order never causes a
 * failure) and only inspects layers with remainingQty > 0; given the non-negative remainingQty
 * invariant, a sum of remainingQty (> 0) is exactly equivalent to a dry-run. Checking up front
 * means an infeasible edit is rejected with a clear, actionable message and zero mutation,
 * instead of deleting the old COGS and then throwing a low-level "insufficient layers" error
 * that only the surrounding transaction rollback saves us from (audit-H9). Callers should pass
 * currentRemainingLayerQty summed over layers with remainingQty > 0 to match that filter.
 *
 * Returns the post-cleanup available quantity (for logging); throws on infeasibility.
 */
export function assertAdjustmentEditFifoFeasible(
  input: AdjustmentEditFifoFeasibilityInput,
): { availableAfterCleanup: number } {
  const currentRemaining = decimalToNumber(input.currentRemainingLayerQty ?? 0)
  const restorable = decimalToNumber(input.restorableConsumedQty ?? 0)
  const removable = decimalToNumber(input.removableLayerQty ?? 0)
  const availableAfterCleanup = currentRemaining + restorable - removable

  // Additions create a new layer at average cost — they never consume, so always feasible.
  if (input.newIsAddition) return { availableAfterCleanup }

  // Use the same shortfall tolerance as the real strict consumption, so the pre-check never
  // rejects an edit that consumeFifoLayersStrict would have accepted.
  if (availableAfterCleanup + FIFO_SHORTFALL_TOLERANCE < input.newAbsQty) {
    throw new Error(
      `Cannot edit this adjustment to remove ${input.newAbsQty} unit(s): only ` +
      `${availableAfterCleanup.toFixed(4)} unit(s) are available in cost layers after accounting ` +
      `for this adjustment. If later movements consumed this stock, reverse those first; ` +
      `otherwise create a compensating adjustment instead of editing this one.`,
    )
  }
  return { availableAfterCleanup }
}
