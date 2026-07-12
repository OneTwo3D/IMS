// decimal-boundary-ok: server-action-boundary (numeric stock adjustment input validation)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'

const QUANTITY_EPSILON = 0.000001

// Mirror the shortfall tolerance consumeFifoLayersStrict applies (lib/cost-layers.ts):
// it accepts a remaining shortfall up to 0.0001. The feasibility pre-check must use the
// SAME tolerance, or it would over-reject edits that the real consumption would accept.
const FIFO_SHORTFALL_TOLERANCE = 0.0001

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

  if (resultingQuantity + QUANTITY_EPSILON < reservedQty) {
    throw new Error(
      `Cannot edit adjustment: resulting stock (${resultingQuantity.toFixed(4)}) ` +
      `would be below reserved quantity (${reservedQty.toFixed(4)}).`,
    )
  }

  return { stockDelta, resultingQuantity, reservedQty }
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
