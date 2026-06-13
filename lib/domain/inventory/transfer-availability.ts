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

/** On-hand minus reserved for a single (product, warehouse) stock level. Never negative. */
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
