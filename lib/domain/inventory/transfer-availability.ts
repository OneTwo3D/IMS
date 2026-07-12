// decimal-boundary-ok: server-action-boundary (numeric stock availability check)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'

// ---------------------------------------------------------------------------
// Transfer-dispatch availability (audit-M-stock #1)
//
// A transfer must not drain stock that an order has already reserved in the
// SOURCE warehouse, or the order is stranded. StockLevel.reservedQty is
// per-(product, warehouse) and kept in sync with order allocations, so the
// available-to-transfer quantity is the warehouse's on-hand minus its reserved
// — netting out exactly the allocations pointing at that warehouse. Centralised
// here so the rule is explicit and regression-tested rather than an inline
// subtraction.
// ---------------------------------------------------------------------------

/**
 * On-hand minus reserved for a single (product, warehouse) stock level, clamped
 * to >= 0. Correct for dispatch gating; do NOT reuse for data-integrity checks —
 * the clamp hides an over-reservation (reservedQty > quantity), which raw
 * subtraction would surface as a negative.
 */
export function availableForTransfer(
  quantity: DecimalLike | null | undefined,
  reservedQty: DecimalLike | null | undefined,
): number {
  const available = decimalToNumber(quantity ?? 0) - decimalToNumber(reservedQty ?? 0)
  return available > 0 ? available : 0
}

/** Whether `requestedQty` can be dispatched without eating into reserved (allocated) stock. */
export function canDispatchTransferQty(
  quantity: DecimalLike | null | undefined,
  reservedQty: DecimalLike | null | undefined,
  requestedQty: number,
): boolean {
  return requestedQty <= availableForTransfer(quantity, reservedQty)
}

// Engine-scale (6dp) shortfall tolerance; mirrors consumeFifoLayersStrict so the
// advisory pre-check never rejects a dispatch the real strict consume would accept.
const FIFO_COVERAGE_TOLERANCE = 0.000001

/**
 * Whether the cost-layer coverage (sum of remaining layer qty) is enough to fully
 * cost a strict dispatch of `requestedQty`. TRANSFER_OUT is a costed outbound
 * movement, so positive stock with insufficient cost layers (a stock/cost-layer
 * desync) must be rejected up front rather than hard-failing mid-dispatch.
 */
export function isCostLayerCoverageSufficient(
  coveredQty: DecimalLike | null | undefined,
  requestedQty: number,
): boolean {
  return requestedQty - decimalToNumber(coveredQty ?? 0) <= FIFO_COVERAGE_TOLERANCE
}
